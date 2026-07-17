import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';

@Injectable()
export class IntegrationsService {
  private readonly rate = new Map<string, { started: number; count: number }>();
  constructor(private readonly prisma: PrismaService, private readonly realtime: RealtimeService) {}

  list() {
    return this.prisma.crm_integrations.findMany({
      select: { id: true, public_id: true, name: true, type: true, token_prefix: true, status: true, last_used_at: true, created_at: true, updated_at: true, automations: { include: { whatsapp_config: { select: { id: true, instance_name: true, business_name: true, display_phone_number: true } }, funnel: { select: { id: true, name: true } }, stage: { select: { id: true, name: true } } } } },
      orderBy: { created_at: 'desc' },
    });
  }

  async options() {
    const [instances, funnels, stages] = await Promise.all([
      this.prisma.whatsapp_config.findMany({ where: { is_active: true }, select: { id: true, instance_name: true, business_name: true, display_phone_number: true } }),
      this.prisma.crm_funnels.findMany({ select: { id: true, name: true, whatsapp_config_id: true } }),
      this.prisma.crm_stages.findMany({ select: { id: true, name: true, funnel_id: true, position: true }, orderBy: { position: 'asc' } }),
    ]);
    return { instances, funnels, stages };
  }

  deliveries() {
    return this.prisma.crm_integration_deliveries.findMany({ include: { integration: { select: { name: true } }, contact: { select: { name: true, phone_number: true } } }, orderBy: { received_at: 'desc' }, take: 100 });
  }

  async create(body: Record<string, unknown>) {
    const name = this.required(body.name, 'name');
    const { token, hash, prefix } = this.token();
    const integration = await this.prisma.crm_integrations.create({ data: { name, type: this.text(body.type) || 'lead_receiver', public_id: `int_${randomBytes(9).toString('hex')}`, token_hash: hash, token_prefix: prefix } });
    return { integration: this.safe(integration), token };
  }

  async update(id: string, body: Record<string, unknown>) {
    await this.find(id);
    return this.prisma.crm_integrations.update({ where: { id }, data: { ...(this.text(body.name) ? { name: this.text(body.name)! } : {}), ...(['active', 'inactive'].includes(String(body.status)) ? { status: String(body.status) } : {}), updated_at: new Date() }, select: { id: true, public_id: true, name: true, type: true, token_prefix: true, status: true, last_used_at: true, created_at: true, updated_at: true } });
  }

  async remove(id: string) {
    await this.find(id);
    await this.prisma.crm_integrations.delete({ where: { id } });
    return { ok: true };
  }

  async rotateToken(id: string) {
    await this.find(id);
    const { token, hash, prefix } = this.token();
    const integration = await this.prisma.crm_integrations.update({ where: { id }, data: { token_hash: hash, token_prefix: prefix, updated_at: new Date() } });
    return { integration: this.safe(integration), token };
  }

  async saveAutomation(integrationId: string, body: Record<string, unknown>) {
    await this.find(integrationId);
    const whatsappConfigId = this.required(body.whatsappConfigId, 'whatsappConfigId');
    const funnelId = this.required(body.funnelId, 'funnelId');
    const stageId = this.required(body.stageId, 'stageId');
    const strategy = this.text(body.existingContactStrategy) || 'keep_current_stage';
    if (!['keep_current_stage', 'move_to_configured_stage', 'ignore'].includes(strategy)) throw new BadRequestException('Estratégia de contato existente inválida');
    const funnel = await this.prisma.crm_funnels.findFirst({ where: { id: funnelId, whatsapp_config_id: whatsappConfigId } });
    if (!funnel) throw new BadRequestException('O funil não pertence à instância selecionada');
    const stage = await this.prisma.crm_stages.findFirst({ where: { id: stageId, funnel_id: funnelId } });
    if (!stage) throw new BadRequestException('O estágio não pertence ao funil selecionado');
    return this.prisma.crm_integration_automations.upsert({
      where: { integration_id_event_type: { integration_id: integrationId, event_type: 'lead.received' } },
      create: { integration_id: integrationId, event_type: 'lead.received', whatsapp_config_id: whatsappConfigId, funnel_id: funnelId, stage_id: stageId, existing_contact_strategy: strategy, is_active: body.isActive !== false },
      update: { whatsapp_config_id: whatsappConfigId, funnel_id: funnelId, stage_id: stageId, existing_contact_strategy: strategy, is_active: body.isActive !== false, updated_at: new Date() },
    });
  }

  async removeAutomation(integrationId: string, id: string) {
    const result = await this.prisma.crm_integration_automations.deleteMany({ where: { id, integration_id: integrationId } });
    if (!result.count) throw new NotFoundException('Automação não encontrada');
    return { ok: true };
  }

  async receiveLead(publicId: string, token: string | undefined, idempotencyKey: string | undefined, body: Record<string, unknown>) {
    const integration = await this.prisma.crm_integrations.findUnique({ where: { public_id: publicId }, include: { automations: { where: { event_type: 'lead.received', is_active: true }, take: 1 } } });
    if (!integration || integration.status !== 'active' || !token || !this.matches(token, integration.token_hash)) throw new UnauthorizedException('Token de integração inválido');
    this.checkRate(integration.id);
    const automation = integration.automations[0];
    if (!automation) throw new ConflictException('Nenhuma automação ativa foi configurada para esta integração');
    const name = this.required(body.name, 'name');
    const phone = this.phone(this.required(body.phone, 'phone'));
    const externalId = this.text(body.externalId);
    const requestId = idempotencyKey?.trim() || randomUUID();
    const previous = await this.prisma.crm_integration_deliveries.findFirst({ where: { OR: [{ request_id: requestId }, ...(externalId ? [{ integration_id: integration.id, external_id: externalId }] : [])] }, include: { contact: true } });
    if (previous) return { ok: previous.status === 'processed', duplicate: true, action: 'unchanged', contactId: previous.contact_id, requestId: previous.request_id };
    let deliveryId: bigint | undefined;
    try {
      const delivery = await this.prisma.crm_integration_deliveries.create({ data: { integration_id: integration.id, external_id: externalId, request_id: requestId, status: 'processing' } });
      deliveryId = delivery.id;
      const result = await this.prisma.$transaction(async tx => {
        const existing = await tx.contacts.findUnique({ where: { whatsapp_config_id_phone_number: { whatsapp_config_id: automation.whatsapp_config_id, phone_number: phone } } });
        if (existing && automation.existing_contact_strategy === 'ignore') return { contact: existing, action: 'ignored' };
        const email = this.text(body.email);
        const metadata = this.json({ ...(existing?.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata) ? existing.metadata as Prisma.JsonObject : {}), ...(body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata as Prisma.JsonObject : {}), ...(email ? { email } : {}), integration_id: integration.id, integration_name: integration.name, ...(externalId ? { external_id: externalId } : {}), source: this.text(body.source) || 'integration', received_at: new Date().toISOString() });
        if (existing) {
          const move = automation.existing_contact_strategy === 'move_to_configured_stage';
          const contact = await tx.contacts.update({ where: { id: existing.id }, data: { name, metadata, last_interaction: new Date(), ...(move ? { crm_funnel_id: automation.funnel_id, crm_stage_id: automation.stage_id } : {}) } });
          return { contact, action: 'updated' };
        }
        const contact = await tx.contacts.create({ data: { name, phone_number: phone, whatsapp_config_id: automation.whatsapp_config_id, crm_funnel_id: automation.funnel_id, crm_stage_id: automation.stage_id, metadata } });
        return { contact, action: 'created' };
      });
      await this.prisma.crm_integration_deliveries.update({ where: { id: deliveryId }, data: { status: 'processed', contact_id: result.contact.id } });
      await this.prisma.crm_integrations.update({ where: { id: integration.id }, data: { last_used_at: new Date() } });
      this.realtime.emit('contact:updated', result.contact as unknown as Record<string, unknown>, [this.realtime.instance(automation.whatsapp_config_id), this.realtime.contact(result.contact.id)]);
      return { ok: true, action: result.action, contactId: result.contact.id, requestId, destination: { instanceId: automation.whatsapp_config_id, funnelId: automation.funnel_id, stageId: automation.stage_id } };
    } catch (error) {
      if (deliveryId) await this.prisma.crm_integration_deliveries.update({ where: { id: deliveryId }, data: { status: 'failed', error: error instanceof Error ? error.message.slice(0, 500) : 'Falha ao processar lead' } }).catch(() => undefined);
      throw error;
    }
  }

  private find(id: string) { return this.prisma.crm_integrations.findUnique({ where: { id } }).then(value => { if (!value) throw new NotFoundException('Integração não encontrada'); return value; }); }
  private token() { const value = `crm_live_${randomBytes(32).toString('base64url')}`; return { token: value, hash: this.hash(value), prefix: value.slice(0, 17) }; }
  private hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
  private matches(value: string, expected: string) { const actual = Buffer.from(this.hash(value), 'hex'); const target = Buffer.from(expected, 'hex'); return actual.length === target.length && timingSafeEqual(actual, target); }
  private safe<T extends { token_hash: string }>(value: T) { const { token_hash: _, ...safe } = value; return safe; }
  private text(value: unknown) { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
  private required(value: unknown, field: string) { const parsed = this.text(value); if (!parsed) throw new BadRequestException(`${field} é obrigatório`); return parsed; }
  private phone(value: string) { const normalized = value.replace(/\D/g, ''); if (normalized.length < 10 || normalized.length > 15) throw new BadRequestException('Telefone inválido; envie país + DDD + número'); return normalized; }
  private json(value: Prisma.InputJsonObject) { return value as Prisma.InputJsonValue; }
  private checkRate(id: string) { const now = Date.now(); const current = this.rate.get(id); if (!current || now - current.started >= 60_000) { this.rate.set(id, { started: now, count: 1 }); return; } current.count += 1; if (current.count > 120) throw new HttpException('Limite de requisições excedido', HttpStatus.TOO_MANY_REQUESTS); }
}
