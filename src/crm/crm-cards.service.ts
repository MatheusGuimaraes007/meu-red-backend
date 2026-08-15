import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, crm_card_kind, crm_card_status } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CrmService } from './crm.service';

type AuthUser = { sub: string; role: string };

/**
 * Cards comercial/suporte (crm_cards) - posicoes de trabalho de um contato,
 * separadas da identidade do contato em si. Ver
 * PROMPT_CODEX_ATUALIZACOES_CRM_PIPELINES_AUTOMACOES_CSV para o desenho.
 *
 * Regra central: no maximo 1 card "sales" ativo e 1 "support" ativo por
 * contato, garantido por indice unico parcial no banco (ver
 * prisma/manual-migrations/20260815_crm_cards.sql). Sempre que dois
 * usuarios competem pelo mesmo card, um recebe 409 - nunca "ultimo clique
 * vence".
 */
@Injectable()
export class CrmCardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly crm: CrmService,
  ) {}

  async listContactCards(contactId: string, user?: AuthUser) {
    await this.crm.contact(contactId, user); // valida existencia + acesso
    const cards = await this.prisma.crm_cards.findMany({
      where: { contact_id: contactId },
      orderBy: [{ status: 'asc' }, { created_at: 'desc' }],
      include: { assigned_user: { select: { id: true, name: true, email: true } } },
    });
    return cards.map((card) => this.cardForClient(card));
  }

  async getCardMovements(cardId: string, user?: AuthUser) {
    const card = await this.requireCard(cardId);
    await this.crm.contact(card.contact_id, user); // valida acesso ao contato do card
    const movements = await this.prisma.crm_card_movements.findMany({
      where: { card_id: cardId },
      orderBy: { created_at: 'desc' },
      include: {
        from_user: { select: { id: true, name: true } },
        to_user: { select: { id: true, name: true } },
        actor: { select: { id: true, name: true } },
      },
    });
    return movements;
  }

  /** Vendedor comum assume um lead comercial para si mesmo (atomico). */
  async claimSalesCard(
    contactId: string,
    body: Record<string, unknown>,
    user: AuthUser,
  ) {
    return this.claimOrAssign(contactId, 'sales', body, user, user.sub);
  }

  /** Admin/Master/Gestor atribui um lead comercial a um vendedor especifico. */
  async assignSalesCard(
    contactId: string,
    body: Record<string, unknown>,
    user: AuthUser,
  ) {
    if (!this.canManageAssignment(user))
      throw new ForbiddenException(
        'Apenas admin, master ou gestor podem atribuir a outro vendedor',
      );
    const assignedUserId = this.string(body.assigned_user_id);
    if (!assignedUserId)
      throw new BadRequestException('assigned_user_id é obrigatório');
    return this.claimOrAssign(contactId, 'sales', body, user, assignedUserId);
  }

  /** Abre atendimento de suporte (support card). */
  async openSupportCard(
    contactId: string,
    body: Record<string, unknown>,
    user: AuthUser,
  ) {
    const rawAssignee = this.string(body.assigned_user_id);
    if (rawAssignee && rawAssignee !== user.sub && !this.canManageAssignment(user))
      throw new ForbiddenException(
        'Apenas admin, master ou gestor podem abrir suporte para outro atendente',
      );
    return this.claimOrAssign(
      contactId,
      'support',
      body,
      user,
      rawAssignee ?? undefined,
      /* allowUnassigned */ true,
    );
  }

  /**
   * Nucleo compartilhado de claim/assign/open: cria o card se nao existir,
   * ou assume o card ativo existente SE ele estiver sem responsavel.
   * Nunca reatribui um card que ja tem responsavel - isso e "transferencia"
   * (ver transferCard), uma acao explicita e auditada separadamente.
   */
  private async claimOrAssign(
    contactId: string,
    kind: crm_card_kind,
    body: Record<string, unknown>,
    actor: AuthUser,
    assignedUserId?: string,
    allowUnassigned = false,
  ) {
    await this.crm.contact(contactId, actor);
    const funnelId = this.string(body.funnel_id);
    const stageId = this.string(body.stage_id);
    if (!funnelId || !stageId)
      throw new BadRequestException('funnel_id e stage_id são obrigatórios');
    const { funnel, stage } = await this.validateFunnelStage(
      funnelId,
      stageId,
      kind,
      assignedUserId,
    );

    const existing = await this.prisma.crm_cards.findFirst({
      where: { contact_id: contactId, kind, status: 'active' },
    });

    if (existing) {
      if (existing.assigned_user_id) {
        if (existing.assigned_user_id === assignedUserId) {
          return this.cardForClient(existing); // idempotente - ja e dele
        }
        const owner = await this.prisma.crm_users.findUnique({
          where: { id: existing.assigned_user_id },
          select: { name: true },
        });
        throw new ConflictException(
          `Este ${kind === 'sales' ? 'lead' : 'atendimento'} já foi atribuído a ${owner?.name ?? 'outro usuário'}.`,
        );
      }
      // Card existe sem responsavel: assume atomicamente (update
      // condicional - se outro claim vencer a corrida, count() vem 0).
      const result = await this.prisma.crm_cards.updateMany({
        where: { id: existing.id, assigned_user_id: null },
        data: {
          assigned_user_id: assignedUserId ?? null,
          funnel_id: funnelId,
          stage_id: stageId,
          stage_entered_at: new Date(),
          assigned_at: assignedUserId ? new Date() : null,
          updated_at: new Date(),
        },
      });
      if (result.count === 0)
        throw new ConflictException(
          `Este ${kind === 'sales' ? 'lead' : 'atendimento'} já foi atribuído a outro usuário.`,
        );
      await this.recordMovement({
        cardId: existing.id,
        contactId,
        kind,
        eventType: 'claimed',
        toUserId: assignedUserId ?? null,
        toFunnelId: funnelId,
        toStageId: stageId,
        actorUserId: actor.sub,
      });
      const updated = await this.requireCard(existing.id);
      this.emitAssignmentChanged(updated, null, assignedUserId ?? null);
      return this.cardForClient(updated);
    }

    if (!assignedUserId && !allowUnassigned)
      throw new BadRequestException('assigned_user_id é obrigatório');

    try {
      const created = await this.prisma.crm_cards.create({
        data: {
          contact_id: contactId,
          kind,
          funnel_id: funnelId,
          stage_id: stageId,
          assigned_user_id: assignedUserId ?? null,
          status: 'active',
          source: 'claim',
          assigned_at: assignedUserId ? new Date() : null,
        },
      });
      await this.recordMovement({
        cardId: created.id,
        contactId,
        kind,
        eventType: 'created',
        toUserId: assignedUserId ?? null,
        toFunnelId: funnelId,
        toStageId: stageId,
        actorUserId: actor.sub,
      });
      this.emitAssignmentChanged(created, null, assignedUserId ?? null);
      void funnel;
      void stage;
      return this.cardForClient(created);
    } catch (error) {
      if (this.isUniqueViolation(error))
        throw new ConflictException(
          `Este ${kind === 'sales' ? 'lead' : 'atendimento'} já foi atribuído a outro usuário.`,
        );
      throw error;
    }
  }

  /**
   * Transferencia explicita (admin/master/gestor): move o MESMO card para
   * outro responsavel/pipeline/etapa, em uma unica transacao. Nunca cria
   * contato, card ou mensagem novos.
   */
  async transferCard(
    cardId: string,
    body: Record<string, unknown>,
    actor: AuthUser,
  ) {
    if (!this.canManageAssignment(actor))
      throw new ForbiddenException(
        'Apenas admin, master ou gestor podem transferir',
      );
    const card = await this.requireCard(cardId);
    if (card.status !== 'active')
      throw new BadRequestException('Card não está ativo');
    const assignedUserId = this.string(body.assigned_user_id) ?? card.assigned_user_id;
    const funnelId = this.string(body.funnel_id) ?? card.funnel_id;
    const stageId = this.string(body.stage_id) ?? card.stage_id;
    const reason = this.string(body.reason);
    await this.validateFunnelStage(funnelId, stageId, card.kind, assignedUserId ?? undefined);

    const fromUserId = card.assigned_user_id;
    const fromFunnelId = card.funnel_id;
    const fromStageId = card.stage_id;
    const stageChanged = fromStageId !== stageId || fromFunnelId !== funnelId;

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.crm_cards.update({
        where: { id: cardId },
        data: {
          assigned_user_id: assignedUserId,
          funnel_id: funnelId,
          stage_id: stageId,
          ...(stageChanged ? { stage_entered_at: new Date() } : {}),
          assigned_at: assignedUserId !== fromUserId ? new Date() : card.assigned_at,
          updated_at: new Date(),
        },
      });
      await tx.crm_card_movements.create({
        data: {
          card_id: cardId,
          contact_id: card.contact_id,
          kind: card.kind,
          event_type: 'transferred',
          from_user_id: fromUserId,
          to_user_id: assignedUserId,
          from_funnel_id: fromFunnelId,
          to_funnel_id: funnelId,
          from_stage_id: fromStageId,
          to_stage_id: stageId,
          actor_user_id: actor.sub,
          reason,
        },
      });
      return next;
    });

    this.emitAssignmentChanged(updated, fromUserId, assignedUserId);
    return this.cardForClient(updated);
  }

  /** Move o card para outra etapa do mesmo pipeline, sem trocar responsavel. */
  async moveCardStage(cardId: string, body: Record<string, unknown>, actor: AuthUser) {
    const card = await this.requireCard(cardId);
    if (card.status !== 'active')
      throw new BadRequestException('Card não está ativo');
    if (!this.canManageAssignment(actor) && card.assigned_user_id !== actor.sub)
      throw new ForbiddenException('Você não é responsável por este card');
    const stageId = this.string(body.stage_id);
    if (!stageId) throw new BadRequestException('stage_id é obrigatório');
    const stage = await this.prisma.crm_stages.findFirst({
      where: { id: stageId, funnel_id: card.funnel_id },
    });
    if (!stage)
      throw new BadRequestException('Etapa não pertence ao pipeline do card');
    if (stageId === card.stage_id) return this.cardForClient(card);

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.crm_cards.update({
        where: { id: cardId },
        data: { stage_id: stageId, stage_entered_at: new Date(), updated_at: new Date() },
      });
      await tx.crm_card_movements.create({
        data: {
          card_id: cardId,
          contact_id: card.contact_id,
          kind: card.kind,
          event_type: 'stage_changed',
          from_stage_id: card.stage_id,
          to_stage_id: stageId,
          from_funnel_id: card.funnel_id,
          to_funnel_id: card.funnel_id,
          actor_user_id: actor.sub,
        },
      });
      return next;
    });
    this.realtime.emit(
      'crm_card:updated',
      this.cardForClient(updated) as unknown as Record<string, unknown>,
      [this.realtime.contact(card.contact_id)],
    );
    return this.cardForClient(updated);
  }

  async closeCard(cardId: string, body: Record<string, unknown>, actor: AuthUser) {
    const card = await this.requireCard(cardId);
    if (card.status === 'closed') return this.cardForClient(card);
    if (!this.canManageAssignment(actor) && card.assigned_user_id !== actor.sub)
      throw new ForbiddenException('Você não é responsável por este card');
    const reason = this.string(body.reason);
    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.crm_cards.update({
        where: { id: cardId },
        data: { status: 'closed', closed_at: new Date(), updated_at: new Date() },
      });
      await tx.crm_card_movements.create({
        data: {
          card_id: cardId,
          contact_id: card.contact_id,
          kind: card.kind,
          event_type: 'closed',
          actor_user_id: actor.sub,
          reason,
        },
      });
      return next;
    });
    this.realtime.emit(
      'crm_card:updated',
      this.cardForClient(updated) as unknown as Record<string, unknown>,
      [this.realtime.contact(card.contact_id)],
    );
    return this.cardForClient(updated);
  }

  // -- helpers ------------------------------------------------------------

  private async requireCard(cardId: string) {
    const card = await this.prisma.crm_cards.findUnique({ where: { id: cardId } });
    if (!card) throw new NotFoundException('Card não encontrado');
    return card;
  }

  private async validateFunnelStage(
    funnelId: string,
    stageId: string,
    kind: crm_card_kind,
    assignedUserId?: string,
  ) {
    const funnel = await this.prisma.crm_funnels.findUnique({ where: { id: funnelId } });
    if (!funnel) throw new BadRequestException('Pipeline não encontrado');
    if (funnel.kind && funnel.kind !== kind)
      throw new BadRequestException(
        `Este pipeline é do tipo ${funnel.kind}, não pode receber card ${kind}`,
      );
    if (
      kind === 'sales' &&
      funnel.owner_user_id &&
      assignedUserId &&
      funnel.owner_user_id !== assignedUserId
    )
      throw new BadRequestException(
        'Este pipeline pertence a outro vendedor',
      );
    const stage = await this.prisma.crm_stages.findFirst({
      where: { id: stageId, funnel_id: funnelId },
    });
    if (!stage) throw new BadRequestException('Etapa não pertence ao pipeline informado');
    return { funnel, stage };
  }

  private async recordMovement(input: {
    cardId: string;
    contactId: string;
    kind: crm_card_kind;
    eventType: 'created' | 'claimed' | 'assigned';
    toUserId?: string | null;
    toFunnelId?: string;
    toStageId?: string;
    actorUserId: string;
  }) {
    await this.prisma.crm_card_movements.create({
      data: {
        card_id: input.cardId,
        contact_id: input.contactId,
        kind: input.kind,
        event_type: input.eventType,
        to_user_id: input.toUserId ?? null,
        to_funnel_id: input.toFunnelId,
        to_stage_id: input.toStageId,
        actor_user_id: input.actorUserId,
      },
    });
  }

  private emitAssignmentChanged(
    card: { id: string; contact_id: string; kind: crm_card_kind; funnel_id: string; stage_id: string; status: crm_card_status },
    fromUserId: string | null,
    toUserId: string | null,
  ) {
    const payload = {
      contactId: card.contact_id,
      cardId: card.id,
      kind: card.kind,
      fromUserId,
      toUserId,
      funnelId: card.funnel_id,
      stageId: card.stage_id,
    };
    const rooms = [
      this.realtime.contact(card.contact_id),
      ...(fromUserId ? [this.realtime.user(fromUserId)] : []),
      ...(toUserId ? [this.realtime.user(toUserId)] : []),
    ];
    this.realtime.emit('conversation:assignment_changed', payload, rooms);
  }

  private canManageAssignment(user: AuthUser) {
    return ['master', 'admin', 'manager'].includes(user.role);
  }

  private isUniqueViolation(error: unknown) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }

  private cardForClient(card: Record<string, unknown>) {
    return card;
  }

  private string(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }
}
