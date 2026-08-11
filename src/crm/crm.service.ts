/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-base-to-string */
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { onboarding_stage, Prisma } from '@prisma/client';
import { hash } from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { MediaStorageService } from '../media/media-storage.service';

@Injectable()
export class CrmService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly realtime: RealtimeService,
    private readonly media: MediaStorageService,
  ) {}

  async contacts(
    userOrInstance?: { sub: string; role: string } | string,
    instanceOrSearch?: string,
    searchOrPage?: string,
    pageOrLimit?: string,
    limitValue?: string,
    funnelValue?: string,
    stageValue?: string,
    tagValue?: string,
  ) {
    const hasUser =
      !!userOrInstance &&
      typeof userOrInstance === 'object' &&
      'sub' in userOrInstance;
    const user = hasUser
      ? (userOrInstance as { sub: string; role: string })
      : undefined;
    const instance = hasUser ? instanceOrSearch : (userOrInstance as string | undefined);
    const search = hasUser ? searchOrPage : instanceOrSearch;
    const pageValue = hasUser ? pageOrLimit : searchOrPage;
    const finalLimitValue = hasUser ? limitValue : pageOrLimit;
    const funnel = hasUser ? funnelValue : undefined;
    const stage = hasUser ? stageValue : undefined;
    const tag = hasUser ? tagValue : undefined;
    const { page, limit, skip } = this.pagination(pageValue, finalLimitValue);
    if (instance) await this.ensureInstanceAccess(instance, user);
    if (funnel) {
      const authorizedFunnel = await this.ensureFunnelAccess(funnel, user);
      if (instance && authorizedFunnel.whatsapp_config_id !== instance)
        throw new BadRequestException('O funil não pertence à instância selecionada');
    }
    if (stage && stage !== 'none') {
      const authorizedStage = await this.ensureStageAccess(stage, user);
      if (funnel && authorizedStage.funnel_id !== funnel)
        throw new BadRequestException('A etapa não pertence ao funil selecionado');
    }
    const where: Prisma.contactsWhereInput = {
      ...(await this.contactAccessWhere(user)),
      ...(instance ? { whatsapp_config_id: instance } : {}),
      ...(funnel ? { crm_funnel_id: funnel } : {}),
      ...(stage ? { crm_stage_id: stage === 'none' ? null : stage } : {}),
      ...(tag ? { crm_contact_tags: { some: { tag_id: tag } } } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { phone_number: { contains: search } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.contacts.findMany({
        where,
        include: {
          _count: { select: { messages: true } },
          crm_contact_tags: { include: { crm_tags: true } },
          messages: { orderBy: { created_at: 'desc' }, take: 1 },
        },
        orderBy: { last_interaction: { sort: 'desc', nulls: 'last' } },
        skip,
        take: limit,
      }),
      this.prisma.contacts.count({ where }),
    ]);
    return {
      items: await Promise.all(
        items.map(async ({ _count, messages, crm_contact_tags, ...contact }) => ({
          ...contact,
          tags: crm_contact_tags.map((item) => item.crm_tags),
          message_count: _count.messages,
          last_message: messages[0]
            ? await this.messageForClient(messages[0], contact)
            : null,
        })),
      ),
      pagination: this.pageMeta(page, limit, total),
    };
  }

  async boardSummary(funnelId: string, instanceId?: string, search?: string, tagId?: string, user?: { sub: string; role: string }) {
    if (!instanceId) throw new BadRequestException('instance_id é obrigatório');
    await this.ensureInstanceAccess(instanceId, user);
    const funnel = await this.ensureFunnelAccess(funnelId, user);
    if (funnel.whatsapp_config_id !== instanceId) throw new BadRequestException('O funil não pertence à instância selecionada');
    if (tagId) {
      const tag = await this.ensureTagAccess(tagId, user);
      if (tag.whatsapp_config_id !== instanceId) throw new BadRequestException('A etiqueta não pertence à instância selecionada');
    }
    const filtered: Prisma.contactsWhereInput = {
      ...(await this.contactAccessWhere(user)), whatsapp_config_id: instanceId, crm_funnel_id: funnelId,
      ...(tagId ? { crm_contact_tags: { some: { tag_id: tagId } } } : {}),
      ...(search ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { phone_number: { contains: search } }] } : {}),
    };
    const [rawGroups, total, withoutStage, withoutFunnel] = await this.prisma.$transaction([
      this.prisma.contacts.groupBy({ by: ['crm_stage_id'], where: filtered, orderBy: { crm_stage_id: 'asc' }, _count: { id: true } }),
      this.prisma.contacts.count({ where: filtered }),
      this.prisma.contacts.count({ where: { ...filtered, crm_stage_id: null } }),
      this.prisma.contacts.count({ where: { ...(await this.contactAccessWhere(user)), whatsapp_config_id: instanceId, crm_funnel_id: null } }),
    ]);
    const groups = rawGroups as Array<{ crm_stage_id: string | null; _count: { id: number } }>;
    return {
      total,
      stages: Object.fromEntries(groups.filter(item => item.crm_stage_id).map(item => [item.crm_stage_id!, item._count.id])),
      withoutStage, withoutFunnel,
      filters: { instance_id: instanceId, funnel_id: funnelId, search: search || null, tag_id: tagId || null },
      generatedAt: new Date().toISOString(),
    };
  }

  async contact(id: string, user?: { sub: string; role: string }) {
    const contact = await this.prisma.contacts.findFirst({
      where: { id, ...(await this.contactAccessWhere(user)) },
      include: { crm_contact_tags: { include: { crm_tags: true } } },
    });
    if (!contact) throw new NotFoundException('Contato não encontrado');
    return this.contactForClient(contact);
  }

  async authorizedContact(id: string, user?: { sub: string; role: string }) {
    const contact = await this.prisma.contacts.findFirst({
      where: { id, ...(await this.contactAccessWhere(user)) },
    });
    if (!contact) throw new NotFoundException('Contato não encontrado');
    return contact;
  }

  async updateContact(
    id: string,
    data: Record<string, unknown>,
    user?: { sub: string; role: string },
  ) {
    const existing = await this.authorizedContact(id, user);
    const update: Prisma.contactsUpdateInput = {};
    if (typeof data.name === 'string') {
      update.name = data.name;
      update.metadata = this.mergeMetadata(existing.metadata, {
        name_source: 'manual',
      });
    }
    if (
      typeof data.onboarding_stage === 'string' &&
      Object.values(onboarding_stage).includes(
        data.onboarding_stage as onboarding_stage,
      )
    )
      update.onboarding_stage = data.onboarding_stage as onboarding_stage;
    if ('metadata' in data)
      update.metadata = this.mergeMetadata(existing.metadata, {
        ...this.metadataObject(data.metadata),
        ...(typeof data.name === 'string' ? { name_source: 'manual' } : {}),
      });
    if ('crm_funnel_id' in data)
      update.crm_funnels = data.crm_funnel_id
        ? { connect: { id: String(data.crm_funnel_id) } }
        : { disconnect: true };
    if ('crm_stage_id' in data)
      update.crm_stages = data.crm_stage_id
        ? { connect: { id: String(data.crm_stage_id) } }
        : { disconnect: true };
    if (data.crm_stage_id) {
      const stage = await this.ensureStageAccess(String(data.crm_stage_id), user);
      const targetFunnel = data.crm_funnel_id ? String(data.crm_funnel_id) : existing.crm_funnel_id;
      if (!targetFunnel || stage.funnel_id !== targetFunnel)
        throw new BadRequestException('A etapa não pertence ao funil selecionado');
    }
    const contact = await this.prisma.contacts.update({
      where: { id },
      data: update,
    });
    void contact;
    const updated = await this.contact(id, user);
    this.emitContact('contact:updated', updated);
    return updated;
  }

  async importContacts(
    data: Record<string, unknown>,
    user?: { sub: string; role: string },
  ) {
    const instanceId = this.string(data.instance_id);
    const funnelId = this.string(data.funnel_id);
    const stageId = this.string(data.stage_id);
    const rawLeads = Array.isArray(data.leads) ? data.leads : [];

    if (!instanceId) throw new BadRequestException('Selecione uma instância');
    if (!funnelId) throw new BadRequestException('Selecione um funil');
    if (!stageId) throw new BadRequestException('Selecione uma etapa');
    if (!rawLeads.length) throw new BadRequestException('Informe pelo menos um lead');
    if (rawLeads.length > 1000)
      throw new BadRequestException('Importe no máximo 1000 leads por vez');

    const [instance, funnel, stage] = await Promise.all([
      this.ensureInstanceAccess(instanceId, user),
      this.ensureFunnelAccess(funnelId, user),
      this.ensureStageAccess(stageId, user),
    ]);
    if (funnel.whatsapp_config_id !== instance.id)
      throw new BadRequestException('O funil não pertence à instância selecionada');
    if (stage.funnel_id !== funnel.id)
      throw new BadRequestException('A etapa não pertence ao funil selecionado');

    const invalid: Array<{ row: number; error: string }> = [];
    const unique = new Map<string, { name: string; phone: string; row: number }>();
    rawLeads.forEach((value, index) => {
      const lead = this.object(value);
      const name = this.string(lead.name ?? lead.nome);
      const phone = this.onlyDigits(lead.phone_number ?? lead.telefone ?? lead.phone);
      if (!name) {
        invalid.push({ row: index + 1, error: 'Nome obrigatório' });
        return;
      }
      if (!phone || phone.length < 10 || phone.length > 15) {
        invalid.push({ row: index + 1, error: 'Telefone inválido; use DDI + DDD + número' });
        return;
      }
      unique.set(phone, { name, phone, row: index + 1 });
    });
    if (!unique.size)
      throw new BadRequestException({ message: 'Nenhum lead válido encontrado', errors: invalid });

    const leads = [...unique.values()];
    const existing = await this.prisma.contacts.findMany({
      where: { whatsapp_config_id: instance.id, phone_number: { in: leads.map(item => item.phone) } },
    });
    const existingByPhone = new Map(existing.map(item => [item.phone_number, item]));
    const importedAt = new Date().toISOString();
    const operations = leads.map(lead => {
      const current = existingByPhone.get(lead.phone);
      return this.prisma.contacts.upsert({
        where: {
          whatsapp_config_id_phone_number: {
            whatsapp_config_id: instance.id,
            phone_number: lead.phone,
          },
        },
        create: {
          whatsapp_config_id: instance.id,
          phone_number: lead.phone,
          name: lead.name,
          crm_funnel_id: funnel.id,
          crm_stage_id: stage.id,
          metadata: {
            lead_source: 'manual_import',
            imported_at: importedAt,
            name_source: 'manual',
          },
        },
        update: {
          name: lead.name,
          crm_funnel_id: funnel.id,
          crm_stage_id: stage.id,
          metadata: this.mergeMetadata(current?.metadata, {
            lead_source: 'manual_import',
            imported_at: importedAt,
            name_source: 'manual',
          }),
        },
      });
    });
    const contacts = await this.prisma.$transaction(operations);
    contacts.forEach(contact =>
      this.emitContact(existingByPhone.has(contact.phone_number) ? 'contact:updated' : 'contact:created', contact),
    );

    return {
      total: contacts.length,
      created: contacts.filter(item => !existingByPhone.has(item.phone_number)).length,
      updated: contacts.filter(item => existingByPhone.has(item.phone_number)).length,
      skipped: rawLeads.length - contacts.length,
      errors: invalid,
      contact_ids: contacts.map(item => item.id),
    };
  }

  private contactForClient(contact: any) {
    const { crm_contact_tags, ...rest } = contact;
    return {
      ...rest,
      tags: Array.isArray(crm_contact_tags)
        ? crm_contact_tags.map((item) => item.crm_tags)
        : [],
    };
  }

  private mergeMetadata(current: unknown, updates: Prisma.InputJsonObject) {
    return {
      ...(current && typeof current === 'object' && !Array.isArray(current)
        ? (current as Prisma.JsonObject)
        : {}),
      ...updates,
    } as Prisma.InputJsonObject;
  }

  private metadataObject(value: unknown) {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Prisma.InputJsonObject)
      : {};
  }

  async messages(
    contactId: string,
    pageValue?: string,
    limitValue?: string,
    user?: { sub: string; role: string },
  ) {
    const contact = await this.authorizedContact(contactId, user);
    const { page, limit, skip } = this.pagination(pageValue, limitValue, 100);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.messages.findMany({
        where: { contact_id: contactId },
        include: { message_edits: { orderBy: { created_at: 'asc' } } },
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.messages.count({ where: { contact_id: contactId } }),
    ]);
    items.reverse();
    return {
      items: await Promise.all(
        items.map((message) => this.messageForClient(message, contact)),
      ),
      pagination: this.pageMeta(page, limit, total),
    };
  }

  async send(
    contactId: string,
    body: Record<string, any>,
    user?: { sub: string; role: string },
  ) {
    await this.authorizedContact(contactId, user);
    const contact = await this.prisma.contacts.findUnique({
      where: { id: contactId },
      include: { whatsapp_config: true },
    });
    if (!contact?.whatsapp_config)
      throw new NotFoundException('Contato ou instância não encontrados');
    const clientMessageId =
      typeof body.clientMessageId === 'string'
        ? body.clientMessageId
        : typeof body.idempotencyKey === 'string'
          ? body.idempotencyKey
          : undefined;
    if (clientMessageId) {
      const existing = await this.prisma.messages.findFirst({
        where: {
          whatsapp_config_id: contact.whatsapp_config.id,
          client_message_id: clientMessageId,
        },
      });
      if (existing) return existing;
    }
    const type = String(body.type || 'text');
    const message = await this.prisma.messages.create({
      data: {
        contact_id: contact.id,
        whatsapp_config_id: contact.whatsapp_config.id,
        role: 'assistant',
        content: String(body.content || `[${type}]`),
        message_type: type,
        client_message_id: clientMessageId,
        status: 'queued',
        media_storage_bucket:
          typeof body.storageBucket === 'string' ? body.storageBucket : null,
        media_storage_path:
          typeof body.storagePath === 'string' ? body.storagePath : null,
        media_mime_type:
          typeof body.mimeType === 'string' ? body.mimeType : null,
        media_extension:
          typeof body.extension === 'string' ? body.extension : null,
        media_original_name:
          typeof body.fileName === 'string' ? body.fileName : null,
        media_size: body.size != null ? BigInt(body.size) : null,
        media_duration_seconds: Number.isFinite(Number(body.durationSeconds))
          ? Number(body.durationSeconds)
          : null,
        media_status: type === 'text' ? null : 'completed',
        metadata: this.json({
          outbound: this.outboundSnapshot(body),
          queued_at: new Date().toISOString(),
        }),
      },
    });
    this.emitMessage('message:created', message);
    setImmediate(() => void this.processQueuedMessage(message.id));
    return message;
  }

  async retry(id: string) {
    const message = await this.prisma.messages.findUnique({
      where: { id: BigInt(id) },
    });
    if (!message) throw new NotFoundException('Mensagem não encontrada');
    if (message.role !== 'assistant')
      throw new BadRequestException(
        'Apenas mensagens enviadas podem ser reenviadas',
      );
    const updated = await this.prisma.messages.update({
      where: { id: message.id },
      data: { status: 'queued', error_message: null, updated_at: new Date() },
    });
    this.emitMessage('message:status', updated);
    setImmediate(() => void this.processQueuedMessage(updated.id));
    return updated;
  }

  async editMessage(id: string, text: string, userId?: string) {
    return this.messageAction(id, { action: 'edit', text }, userId);
  }
  async deleteMessage(id: string) {
    return this.messageAction(id, { action: 'delete' });
  }

  async messageAction(id: string, body: Record<string, any>, userId?: string) {
    const message = await this.prisma.messages.findUnique({
      where: { id: BigInt(id) },
      include: { contacts: true, whatsapp_config: true },
    });
    if (!message?.whatsapp_config)
      throw new NotFoundException('Mensagem não encontrada');
    if (!message.external_message_id)
      throw new BadRequestException('Mensagem ainda não possui ID da W-API');
    const action = body.action === 'delete' ? 'delete' : 'edit';
    if (action === 'edit' && (!body.text || typeof body.text !== 'string'))
      throw new BadRequestException('text é obrigatório');
    const url = new URL(`${this.baseUrl()}/v1/message/${action}-message`);
    url.searchParams.set(
      'instanceId',
      message.whatsapp_config.provider_instance_id || '',
    );
    url.searchParams.set('phone', message.contacts.phone_number);
    url.searchParams.set('messageId', message.external_message_id);
    const response = await fetch(url, {
      method: action === 'delete' ? 'DELETE' : 'POST',
      headers: {
        Authorization: `Bearer ${message.whatsapp_config.provider_token || ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        phone: message.contacts.phone_number,
        messageId: message.external_message_id,
        text: body.text,
      }),
    });
    const provider = (await response.json().catch(() => ({}))) as Record<
      string,
      any
    >;
    if (!response.ok || provider.error)
      throw new BadRequestException(provider.message || 'W-API action failed');
    const updated = await this.prisma.$transaction(async (tx) => {
      if (action === 'edit') {
        await tx.message_edits.create({
          data: {
            message_id: message.id,
            previous_content: message.edited_content ?? message.content,
            new_content: body.text,
            edited_by: userId,
          },
        });
      }
      return tx.messages.update({
        where: { id: message.id },
        data:
          action === 'edit'
            ? {
                original_content: message.original_content ?? message.content,
                edited_content: body.text,
                content: body.text,
                updated_at: new Date(),
              }
            : {
                deleted_on_whatsapp: true,
                deleted_at: new Date(),
                updated_at: new Date(),
              },
        include: { message_edits: { orderBy: { created_at: 'asc' } } },
      });
    });
    this.emitMessage(
      action === 'delete' ? 'message:deleted_on_whatsapp' : 'message:updated',
      updated,
    );
    return updated;
  }

  async markConversationRead(contactId: string, user?: { sub: string; role: string }) {
    const contact = await this.authorizedContact(contactId, user);
    const metadata = this.object(contact.metadata);
    const readAt = new Date();
    await this.prisma.$transaction([
      this.prisma.messages.updateMany({
        where: { contact_id: contactId, role: 'user', read_at: null },
        data: { read_at: readAt, updated_at: readAt },
      }),
      this.prisma.contacts.update({
        where: { id: contactId },
        data: {
          metadata: this.json({
            ...metadata,
            needs_reply: false,
            last_read_at: readAt.toISOString(),
          }),
        },
      }),
    ]);
    const result = {
      contactId,
      readAt,
      whatsappConfigId: contact.whatsapp_config_id,
    };
    this.realtime.emit(
      'conversation:read',
      result as unknown as Record<string, unknown>,
      [
        this.realtime.contact(contactId),
        ...(contact.whatsapp_config_id
          ? [this.realtime.instance(contact.whatsapp_config_id)]
          : []),
      ],
    );
    return result;
  }

  async funnels(instance?: string, user?: { sub: string; role: string }) {
    return this.prisma.crm_funnels
      .findMany({
        where: {
          ...(await this.funnelAccessWhere(user)),
          ...(instance ? { whatsapp_config_id: instance } : {}),
        },
        include: { crm_stages: { orderBy: { position: 'asc' } } },
        orderBy: { created_at: 'asc' },
      })
      .then((rows) =>
        rows.map(({ crm_stages, ...funnel }) => ({
          ...funnel,
          stages: crm_stages,
        })),
      );
  }

  async tags(instance?: string, user?: { sub: string; role: string }) {
    if (instance) await this.ensureInstanceAccess(instance, user);
    const ids = this.isAdmin(user) ? null : await this.accessIds(user);
    return this.prisma.crm_tags.findMany({
      where: {
        ...(instance ? { whatsapp_config_id: instance } : {}),
        ...(this.isAdmin(user)
          ? {}
          : { whatsapp_config_id: { in: ids!.instanceIds } }),
      },
      orderBy: [{ name: 'asc' }],
    });
  }

  async createTag(
    data: Record<string, unknown>,
    user?: { sub: string; role: string },
  ) {
    const name = this.string(data.name);
    const instanceId = this.string(data.instance_id ?? data.whatsapp_config_id);
    if (!name) throw new BadRequestException('Nome da etiqueta é obrigatório');
    if (instanceId) await this.ensureInstanceAccess(instanceId, user);
    const tag = await this.prisma.crm_tags.create({
      data: {
        name,
        whatsapp_config_id: instanceId,
        color: this.string(data.color) ?? '#e63946',
      },
    });
    return tag;
  }

  async updateTag(
    id: string,
    data: Record<string, unknown>,
    user?: { sub: string; role: string },
  ) {
    await this.ensureTagAccess(id, user);
    const update: Prisma.crm_tagsUpdateInput = {};
    const name = this.string(data.name);
    const color = this.string(data.color);
    if (name) update.name = name;
    if (color) update.color = color;
    return this.prisma.crm_tags.update({
      where: { id },
      data: { ...update, updated_at: new Date() },
    });
  }

  async deleteTag(id: string, user?: { sub: string; role: string }) {
    await this.ensureTagAccess(id, user);
    await this.prisma.crm_tags.delete({ where: { id } });
    return { ok: true };
  }

  async addContactTag(
    contactId: string,
    tagId: string,
    user?: { sub: string; role: string },
  ) {
    await this.authorizedContact(contactId, user);
    await this.ensureTagAccess(tagId, user);
    await this.prisma.crm_contact_tags.upsert({
      where: { contact_id_tag_id: { contact_id: contactId, tag_id: tagId } },
      create: { contact_id: contactId, tag_id: tagId },
      update: {},
    });
    const contact = await this.contact(contactId, user);
    this.emitContact('contact:updated', contact);
    return contact;
  }

  async removeContactTag(
    contactId: string,
    tagId: string,
    user?: { sub: string; role: string },
  ) {
    await this.authorizedContact(contactId, user);
    await this.ensureTagAccess(tagId, user);
    await this.prisma.crm_contact_tags.deleteMany({
      where: { contact_id: contactId, tag_id: tagId },
    });
    const contact = await this.contact(contactId, user);
    this.emitContact('contact:updated', contact);
    return contact;
  }

  async createFunnel(
    data: Record<string, unknown>,
    user?: { sub: string; role: string },
  ) {
    const instanceId = this.string(data.instance_id ?? data.whatsapp_config_id);
    const name = this.string(data.name);
    if (!instanceId) throw new BadRequestException('Instância é obrigatória');
    if (!name) throw new BadRequestException('Nome do funil é obrigatório');
    await this.ensureInstanceAccess(instanceId, user);
    const funnel = await this.prisma.crm_funnels.create({
      data: {
        whatsapp_config_id: instanceId,
        name,
        is_default: false,
      },
    });
    return funnel;
  }

  async updateFunnel(
    id: string,
    data: Record<string, unknown>,
    user?: { sub: string; role: string },
  ) {
    const funnel = await this.ensureFunnelAccess(id, user);
    const update: Prisma.crm_funnelsUpdateInput = {};
    const name = this.string(data.name);
    if (name) update.name = name;
    const hasEntryStage = Object.prototype.hasOwnProperty.call(
      data,
      'entry_stage_id',
    );
    const entryStageId = this.string(data.entry_stage_id);
    if (hasEntryStage) {
      if (entryStageId) {
        const stage = await this.prisma.crm_stages.findFirst({
          where: { id: entryStageId, funnel_id: id },
        });
        if (!stage)
          throw new BadRequestException('A etapa de entrada deve pertencer ao funil');
        update.entry_stage = { connect: { id: entryStageId } };
      } else {
        update.entry_stage = { disconnect: true };
      }
    }
    const hasDefault = typeof data.is_default === 'boolean';
    const isDefault = data.is_default === true;
    if (hasDefault) {
      if (isDefault && !(entryStageId ?? funnel.entry_stage_id))
        throw new BadRequestException('Escolha a etapa de entrada da automação');
      update.is_default = isDefault;
    }
    if (!Object.keys(update).length) return this.ensureFunnelAccess(id, user);
    return this.prisma.$transaction(async (tx) => {
      if (isDefault) {
        await tx.crm_funnels.updateMany({
          where: {
            whatsapp_config_id: funnel.whatsapp_config_id,
            id: { not: id },
            is_default: true,
          },
          data: { is_default: false, updated_at: new Date() },
        });
      }
      return tx.crm_funnels.update({
        where: { id },
        data: { ...update, updated_at: new Date() },
      });
    });
  }

  async availableFunnelContacts(
    funnelId: string,
    search?: string,
    user?: { sub: string; role: string },
  ) {
    const funnel = await this.ensureFunnelAccess(funnelId, user);
    const term = this.string(search);
    return this.prisma.contacts.findMany({
      where: {
        whatsapp_config_id: funnel.whatsapp_config_id,
        crm_funnel_id: null,
        ...(term
          ? {
              OR: [
                { name: { contains: term, mode: 'insensitive' } },
                { phone_number: { contains: term } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
        phone_number: true,
        last_interaction: true,
      },
      orderBy: { last_interaction: { sort: 'desc', nulls: 'last' } },
      take: 100,
    });
  }

  async addContactsToFunnel(
    funnelId: string,
    data: Record<string, unknown>,
    user?: { sub: string; role: string },
  ) {
    const funnel = await this.ensureFunnelAccess(funnelId, user);
    const stageId = this.string(data.stage_id);
    const contactIds = Array.isArray(data.contact_ids)
      ? [...new Set(data.contact_ids.map((id) => this.string(id)).filter(Boolean))]
      : [];
    if (!stageId) throw new BadRequestException('Etapa de destino é obrigatória');
    if (!contactIds.length)
      throw new BadRequestException('Selecione pelo menos um contato');
    if (contactIds.length > 100)
      throw new BadRequestException('Selecione no máximo 100 contatos por vez');
    const stage = await this.prisma.crm_stages.findFirst({
      where: { id: stageId, funnel_id: funnelId },
    });
    if (!stage)
      throw new BadRequestException('A etapa de destino deve pertencer ao funil');
    const result = await this.prisma.contacts.updateMany({
      where: {
        id: { in: contactIds as string[] },
        whatsapp_config_id: funnel.whatsapp_config_id,
        crm_funnel_id: null,
      },
      data: { crm_funnel_id: funnelId, crm_stage_id: stageId },
    });
    return { ok: true, count: result.count };
  }

  async createStage(
    funnelId: string,
    data: Record<string, unknown>,
    user?: { sub: string; role: string },
  ) {
    await this.ensureFunnelAccess(funnelId, user);
    const name = this.string(data.name);
    if (!name) throw new BadRequestException('Nome da etapa é obrigatório');
    const position =
      Number.isFinite(Number(data.position)) && Number(data.position) > 0
        ? Number(data.position)
        : (await this.prisma.crm_stages.count({ where: { funnel_id: funnelId } })) + 1;
    return this.prisma.crm_stages.create({
      data: {
        funnel_id: funnelId,
        name,
        position,
        color: this.string(data.color) ?? '#e63946',
      },
    });
  }

  async updateStage(
    id: string,
    data: Record<string, unknown>,
    user?: { sub: string; role: string },
  ) {
    await this.ensureStageAccess(id, user);
    const update: Prisma.crm_stagesUpdateInput = {};
    const name = this.string(data.name);
    const color = this.string(data.color);
    if (name) update.name = name;
    if (color) update.color = color;
    if (Number.isFinite(Number(data.position)))
      update.position = Number(data.position);
    if (!Object.keys(update).length) return this.ensureStageAccess(id, user);
    return this.prisma.crm_stages.update({
      where: { id },
      data: { ...update, updated_at: new Date() },
    });
  }

  async moveStage(
    id: string,
    data: Record<string, unknown>,
    user?: { sub: string; role: string },
  ) {
    const stage = await this.ensureStageAccess(id, user);
    const direction = this.string(data.direction);
    const stages = await this.prisma.crm_stages.findMany({
      where: { funnel_id: stage.funnel_id },
      orderBy: [{ position: 'asc' }, { created_at: 'asc' }],
    });
    const index = stages.findIndex((item) => item.id === id);
    const targetIndex = direction === 'left' ? index - 1 : index + 1;
    const target = stages[targetIndex];
    if (index < 0 || !target) return stage;
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.crm_stages.update({
        where: { id: stage.id },
        data: { position: target.position, updated_at: now },
      }),
      this.prisma.crm_stages.update({
        where: { id: target.id },
        data: { position: stage.position, updated_at: now },
      }),
    ]);
    return this.prisma.crm_stages.findUnique({ where: { id } });
  }

  async deleteStage(id: string, user?: { sub: string; role: string }) {
    await this.ensureStageAccess(id, user);
    await this.prisma.crm_funnels.updateMany({
      where: { entry_stage_id: id },
      data: { entry_stage_id: null, is_default: false, updated_at: new Date() },
    });
    await this.prisma.contacts.updateMany({
      where: { crm_stage_id: id },
      data: { crm_stage_id: null },
    });
    await this.prisma.crm_stages.delete({ where: { id } });
    return { ok: true };
  }

  async dashboard(user?: { sub: string; role: string }) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const contactWhere = await this.contactAccessWhere(user);
    const dashboardAccess = await this.dashboardAccess(user);
    const [contactTotal, pending, messageTotal, today, instances] =
      await Promise.all([
        this.prisma.contacts.count({ where: contactWhere }),
        this.prisma.contacts.count({
          where: { ...contactWhere, metadata: { path: ['needs_reply'], equals: true } },
        }),
        this.prisma.messages.count({ where: { contacts: contactWhere } }),
        this.prisma.messages.count({
          where: { contacts: contactWhere, created_at: { gte: startOfDay } },
        }),
        this.prisma.whatsapp_config.count({
          where: {
            is_active: true,
            ...(this.isAdmin(user) ? {} : { id: { in: dashboardAccess.instanceIds } }),
          },
        }),
      ]);
    return {
      contacts: { total: contactTotal, pending },
      messages: { total: messageTotal, today },
      instances: { total: instances },
    };
  }

  knowledge() {
    return this.prisma.knowledge_base.findMany({
      orderBy: { created_at: 'desc' },
    });
  }
  aiInstances() {
    return this.prisma.ai_instances.findMany({
      orderBy: { created_at: 'desc' },
    });
  }
  async users() {
    const users = await this.prisma.crm_users.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        status: true,
        created_at: true,
        updated_at: true,
      },
      orderBy: { created_at: 'asc' },
    });
    return Promise.all(users.map((user) => this.userWithPermissions(user.id)));
  }

  async createUser(data: Record<string, unknown>) {
    const password = String(data.password || '');
    if (password.length < 8) throw new BadRequestException('Senha deve ter pelo menos 8 caracteres');
    const user = await this.prisma.crm_users.create({
      data: {
        name: String(data.name || '').trim(),
        email: String(data.email || '').trim().toLowerCase(),
        password_hash: await hash(password, 12),
        role: ['admin', 'manager', 'agent'].includes(String(data.role)) ? String(data.role) : 'agent',
        status: String(data.status || 'active'),
      },
    });
    await this.setUserPermissions(user.id, data.permissions as Record<string, unknown>);
    return this.userWithPermissions(user.id);
  }

  async updateUser(id: string, data: Record<string, unknown>) {
    const update: Prisma.crm_usersUpdateInput = {};
    if (typeof data.name === 'string') update.name = data.name.trim();
    if (typeof data.email === 'string') update.email = data.email.trim().toLowerCase();
    if (typeof data.role === 'string' && ['admin', 'manager', 'agent'].includes(data.role)) update.role = data.role;
    if (typeof data.status === 'string') update.status = data.status;
    if (typeof data.password === 'string' && data.password.length >= 8) update.password_hash = await hash(data.password, 12);
    if (Object.keys(update).length) await this.prisma.crm_users.update({ where: { id }, data: { ...update, updated_at: new Date() } });
    if ('permissions' in data) await this.setUserPermissions(id, data.permissions as Record<string, unknown>);
    return this.userWithPermissions(id);
  }

  async updateOwnAccount(id: string, data: Record<string, unknown>) {
    const update: Prisma.crm_usersUpdateInput = {};
    if (typeof data.name === 'string') update.name = data.name.trim();
    if (typeof data.password === 'string' && data.password.length >= 8) update.password_hash = await hash(data.password, 12);
    if (!Object.keys(update).length) return this.userWithPermissions(id);
    await this.prisma.crm_users.update({ where: { id }, data: { ...update, updated_at: new Date() } });
    return this.userWithPermissions(id);
  }

  async userWithPermissions(id: string) {
    const user = await this.prisma.crm_users.findUnique({
      where: { id },
      select: { id: true, name: true, email: true, role: true, status: true, created_at: true, updated_at: true },
    });
    if (!user) throw new NotFoundException('Usuário não encontrado');
    const [instances, contacts, funnels, dashboards] = await Promise.all([
      this.prisma.crm_user_instance_permissions.findMany({ where: { user_id: id }, select: { whatsapp_config_id: true } }),
      this.prisma.crm_user_contact_permissions.findMany({ where: { user_id: id }, select: { contact_id: true } }),
      this.prisma.crm_user_funnel_permissions.findMany({ where: { user_id: id }, select: { funnel_id: true } }),
      this.prisma.crm_user_dashboard_permissions.findMany({ where: { user_id: id }, select: { dashboard_key: true } }),
    ]);
    return {
      ...user,
      permissions: {
        instanceIds: instances.map(item => item.whatsapp_config_id),
        contactIds: contacts.map(item => item.contact_id),
        funnelIds: funnels.map(item => item.funnel_id),
        dashboards: dashboards.map(item => item.dashboard_key),
      },
    };
  }

  async permissionOptions() {
    const [instances, contacts, funnels] = await Promise.all([
      this.prisma.whatsapp_config.findMany({
        select: { id: true, display_phone_number: true, business_name: true, instance_name: true, provider_instance_id: true },
        orderBy: { updated_at: 'desc' },
      }),
      this.prisma.contacts.findMany({
        select: { id: true, name: true, phone_number: true, whatsapp_config_id: true },
        orderBy: { last_interaction: { sort: 'desc', nulls: 'last' } },
        take: 500,
      }),
      this.prisma.crm_funnels.findMany({
        select: { id: true, name: true, whatsapp_config_id: true },
        orderBy: { created_at: 'asc' },
      }),
    ]);
    return { instances, contacts, funnels, dashboards: ['own', 'global'] };
  }

  private async processQueuedMessage(id: bigint) {
    const message = await this.prisma.messages.findUnique({
      where: { id },
      include: { contacts: true, whatsapp_config: true },
    });
    if (!message?.whatsapp_config || message.status !== 'queued') return;
    try {
      const sending = await this.prisma.messages.update({
        where: { id },
        data: { status: 'sending', updated_at: new Date() },
      });
      this.emitMessage('message:status', sending);
      const metadata = this.object(message.metadata);
      const outbound = this.object(metadata.outbound);
      const type = message.message_type;
      const endpoint = `${this.baseUrl()}/v1/message/send-${type}?instanceId=${encodeURIComponent(message.whatsapp_config.provider_instance_id || '')}`;
      const key = type === 'text' ? 'message' : type;
      const storedUrl = await this.media.signedUrl(
        message.media_storage_bucket,
        message.media_storage_path,
      );
      const payload = {
        phone: message.contacts.phone_number,
        [key]:
          type === 'text'
            ? message.content
            : storedUrl || outbound.url || message.content,
        caption: outbound.caption || '',
        fileName: outbound.fileName || message.media_original_name,
        extension: outbound.extension || message.media_extension,
        delayMessage: 0,
      };
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${message.whatsapp_config.provider_token || ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const provider = (await response.json().catch(() => ({}))) as Record<
        string,
        any
      >;
      if (!response.ok || provider.error)
        throw new Error(provider.message || `W-API HTTP ${response.status}`);
      const sent = await this.prisma.messages.update({
        where: { id },
        data: {
          status: 'sent',
          external_message_id: provider.messageId || provider.id || null,
          metadata: this.json({
            ...metadata,
            provider_send: provider,
            sent_at: new Date().toISOString(),
          }),
          updated_at: new Date(),
        },
      });
      this.emitMessage('message:status', sent);
      this.emitMessage('message:updated', sent);
    } catch (error) {
      const failed = await this.prisma.messages.update({
        where: { id },
        data: {
          status: 'failed',
          error_message: (error instanceof Error
            ? error.message
            : String(error)
          ).slice(0, 2000),
          updated_at: new Date(),
        },
      });
      this.emitMessage('message:failed', failed);
    }
  }

  private emitMessage(event: string, message: any) {
    const rooms = [
      this.realtime.contact(message.contact_id),
      ...(message.whatsapp_config_id
        ? [this.realtime.instance(message.whatsapp_config_id)]
        : []),
    ];
    void this.messageForClient(message)
      .then((payload) =>
        this.realtime.emit(event, payload as Record<string, unknown>, rooms),
      )
      .catch(() =>
        this.realtime.emit(event, message as Record<string, unknown>, rooms),
      );
  }
  private emitContact(event: string, contact: any) {
    this.realtime.emit(event, contact as Record<string, unknown>, [
      this.realtime.contact(contact.id),
      ...(contact.whatsapp_config_id
        ? [this.realtime.instance(contact.whatsapp_config_id)]
        : []),
    ]);
  }
  private outboundSnapshot(body: Record<string, any>) {
    return {
      content: body.content,
      url: body.url,
      caption: body.caption,
      fileName: body.fileName,
      extension: body.extension,
      storageBucket: body.storageBucket,
      storagePath: body.storagePath,
      mimeType: body.mimeType,
      size: body.size,
      durationSeconds: body.durationSeconds,
    };
  }
  private async messageForClient<
    T extends {
      id?: bigint | number | string;
      message_type?: string | null;
      media_mime_type?: string | null;
      media_original_name?: string | null;
      media_size?: bigint | number | null;
      media_status?: string | null;
      media_error?: string | null;
      media_storage_bucket?: string | null;
      media_storage_path?: string | null;
      metadata?: unknown;
    },
  >(
    message: T,
    contact?: { metadata?: unknown } | null,
  ) {
    const metadata = this.object(message.metadata);
    const replyTo = this.object(metadata.reply_to);
    const mediaUrl =
      (await this.media.signedUrl(
        message.media_storage_bucket,
        message.media_storage_path,
      )) ?? this.mediaUrlFromMetadata(metadata);
    const attachment = this.messageAttachmentForClient(message, mediaUrl);
    const sender = this.messageSenderForClient(metadata, contact);
    return {
      ...message,
      reply_to: Object.keys(replyTo).length > 0 ? replyTo : null,
      media_url: mediaUrl,
      attachments: attachment ? [attachment] : [],
      sender_name: sender?.name ?? metadata.sender_name ?? null,
      sender_id: sender?.id ?? metadata.sender_id ?? null,
      sender_phone: sender?.phone ?? metadata.sender_phone ?? null,
      sender_profile_picture:
        sender?.profilePicture ?? metadata.sender_profile_picture ?? null,
      group_sender: sender,
    };
  }

  private messageSenderForClient(
    metadata: Record<string, any>,
    contact?: { metadata?: unknown } | null,
  ) {
    const contactMetadata = this.object(contact?.metadata);
    const participants = Array.isArray(contactMetadata.group_participants)
      ? contactMetadata.group_participants
      : [];
    const identity = this.string(metadata.participant ?? metadata.sender_id);
    const senderId = this.string(metadata.sender_id);
    const senderPhone = this.string(metadata.sender_phone);
    const identityDigits = this.onlyDigits(identity);
    const senderDigits = this.onlyDigits(senderPhone ?? senderId);
    const participant = participants
      .map((item) => this.object(item))
      .find((item) => {
        const ids = [
          this.string(item.id),
          this.string(item.phone),
          this.string(item.lid),
        ].filter(Boolean) as string[];
        return ids.some((id) => {
          if (id === identity || id === senderId || id === senderPhone) return true;
          const digits = this.onlyDigits(id);
          return !!digits && (digits === identityDigits || digits === senderDigits);
        });
      });
    const name = this.string(participant?.name) ?? this.string(metadata.sender_name);
    const phone =
      this.string(participant?.phone) ??
      this.string(metadata.sender_phone) ??
      this.string(metadata.sender_id);
    const profilePicture =
      this.string(participant?.profilePicture) ??
      this.string(metadata.sender_profile_picture);
    if (!name && !phone && !identity && !profilePicture) return null;
    return {
      id: this.string(participant?.id) ?? identity ?? senderId ?? phone,
      phone: phone ?? null,
      lid: this.string(participant?.lid) ?? null,
      name: name ?? phone ?? identity ?? null,
      profilePicture: profilePicture ?? null,
      isAdmin: participant?.isAdmin === true,
      isSuperAdmin: participant?.isSuperAdmin === true,
      role: this.string(participant?.role) ?? null,
    };
  }

  private messageAttachmentForClient(
    message: {
      id?: bigint | number | string;
      message_type?: string | null;
      media_mime_type?: string | null;
      media_original_name?: string | null;
      media_size?: bigint | number | null;
      media_status?: string | null;
      media_error?: string | null;
    },
    url: string | null,
  ) {
    const type = String(message.message_type ?? '').toLowerCase();
    if (!['image', 'video', 'audio', 'document', 'sticker', 'gif'].includes(type))
      return null;
    const status = String(message.media_status ?? (url ? 'completed' : 'pending'));
    return {
      id: String(message.id ?? ''),
      type,
      mimeType: message.media_mime_type ?? null,
      fileName: message.media_original_name ?? null,
      fileSize:
        typeof message.media_size === 'bigint'
          ? Number(message.media_size)
          : (message.media_size ?? null),
      status,
      statusLabel: this.mediaStatusLabel(status),
      error: message.media_error ?? null,
      url,
    };
  }

  private mediaStatusLabel(status: string) {
    const labels: Record<string, string> = {
      pending: 'Mídia aguardando processamento',
      processing: 'Mídia em processamento',
      completed: 'Mídia pronta para exibição',
      failed: 'Não foi possível processar a mídia',
    };
    return labels[status] ?? 'Status de mídia desconhecido';
  }

  private mediaUrlFromMetadata(metadata: Record<string, unknown>) {
    return this.findMediaUrl(this.object(metadata.raw));
  }

  private async ensureInstanceAccess(
    id: string,
    user?: { sub: string; role: string },
  ) {
    const instance = await this.prisma.whatsapp_config.findFirst({
      where: {
        id,
        ...(this.isAdmin(user)
          ? {}
          : {
              crm_user_instance_permissions: {
                some: { user_id: user!.sub },
              },
            }),
      },
    });
    if (!instance) throw new NotFoundException('Instância não encontrada');
    return instance;
  }

  private async ensureFunnelAccess(
    id: string,
    user?: { sub: string; role: string },
  ) {
    const funnel = await this.prisma.crm_funnels.findFirst({
      where: { id, ...(await this.funnelAccessWhere(user)) },
    });
    if (!funnel) throw new NotFoundException('Funil não encontrado');
    return funnel;
  }

  private async ensureStageAccess(
    id: string,
    user?: { sub: string; role: string },
  ) {
    const stage = await this.prisma.crm_stages.findFirst({
      where: { id, crm_funnels: await this.funnelAccessWhere(user) },
    });
    if (!stage) throw new NotFoundException('Etapa não encontrada');
    return stage;
  }

  private async ensureTagAccess(
    id: string,
    user?: { sub: string; role: string },
  ) {
    const ids = this.isAdmin(user) ? null : await this.accessIds(user);
    const tag = await this.prisma.crm_tags.findFirst({
      where: {
        id,
        ...(this.isAdmin(user)
          ? {}
          : { whatsapp_config_id: { in: ids!.instanceIds } }),
      },
    });
    if (!tag) throw new NotFoundException('Etiqueta não encontrada');
    return tag;
  }

  private isAdmin(user?: { role: string } | null) {
    return !user || ['master', 'admin'].includes(user.role);
  }

  private async accessIds(user?: { sub: string; role: string }) {
    if (this.isAdmin(user)) {
      return { instanceIds: [] as string[], contactIds: [] as string[], funnelIds: [] as string[] };
    }
    const [instances, contacts, funnels] = await Promise.all([
      this.prisma.crm_user_instance_permissions.findMany({
        where: { user_id: user!.sub },
        select: { whatsapp_config_id: true },
      }),
      this.prisma.crm_user_contact_permissions.findMany({
        where: { user_id: user!.sub },
        select: { contact_id: true },
      }),
      this.prisma.crm_user_funnel_permissions.findMany({
        where: { user_id: user!.sub },
        select: { funnel_id: true },
      }),
    ]);
    return {
      instanceIds: instances.map(item => item.whatsapp_config_id),
      contactIds: contacts.map(item => item.contact_id),
      funnelIds: funnels.map(item => item.funnel_id),
    };
  }

  private async contactAccessWhere(user?: { sub: string; role: string }): Promise<Prisma.contactsWhereInput> {
    if (this.isAdmin(user)) return {};
    const ids = await this.accessIds(user);
    const or: Prisma.contactsWhereInput[] = [];
    if (ids.instanceIds.length) or.push({ whatsapp_config_id: { in: ids.instanceIds } });
    if (ids.contactIds.length) or.push({ id: { in: ids.contactIds } });
    if (ids.funnelIds.length) or.push({ crm_funnel_id: { in: ids.funnelIds } });
    return or.length ? { OR: or } : { id: { in: [] } };
  }

  private async funnelAccessWhere(user?: { sub: string; role: string }): Promise<Prisma.crm_funnelsWhereInput> {
    if (this.isAdmin(user)) return {};
    const ids = await this.accessIds(user);
    const or: Prisma.crm_funnelsWhereInput[] = [];
    if (ids.instanceIds.length) or.push({ whatsapp_config_id: { in: ids.instanceIds } });
    if (ids.funnelIds.length) or.push({ id: { in: ids.funnelIds } });
    return or.length ? { OR: or } : { id: { in: [] } };
  }

  private async dashboardAccess(user?: { sub: string; role: string }) {
    if (this.isAdmin(user)) return { keys: ['global'], instanceIds: [] as string[] };
    const [dashboards, access] = await Promise.all([
      this.prisma.crm_user_dashboard_permissions.findMany({
        where: { user_id: user!.sub },
        select: { dashboard_key: true },
      }),
      this.accessIds(user),
    ]);
    const keys = dashboards.map(item => item.dashboard_key);
    return { keys, instanceIds: access.instanceIds };
  }

  private async setUserPermissions(userId: string, value?: Record<string, unknown>) {
    const permissions = value && typeof value === 'object' ? value : {};
    const instanceIds = this.stringArray(permissions.instanceIds);
    const contactIds = this.stringArray(permissions.contactIds);
    const funnelIds = this.stringArray(permissions.funnelIds);
    const dashboards = this.stringArray(permissions.dashboards);
    await this.prisma.$transaction([
      this.prisma.crm_user_instance_permissions.deleteMany({ where: { user_id: userId } }),
      this.prisma.crm_user_contact_permissions.deleteMany({ where: { user_id: userId } }),
      this.prisma.crm_user_funnel_permissions.deleteMany({ where: { user_id: userId } }),
      this.prisma.crm_user_dashboard_permissions.deleteMany({ where: { user_id: userId } }),
      ...instanceIds.map(whatsapp_config_id =>
        this.prisma.crm_user_instance_permissions.create({ data: { user_id: userId, whatsapp_config_id } }),
      ),
      ...contactIds.map(contact_id =>
        this.prisma.crm_user_contact_permissions.create({ data: { user_id: userId, contact_id } }),
      ),
      ...funnelIds.map(funnel_id =>
        this.prisma.crm_user_funnel_permissions.create({ data: { user_id: userId, funnel_id } }),
      ),
      ...dashboards.map(dashboard_key =>
        this.prisma.crm_user_dashboard_permissions.create({ data: { user_id: userId, dashboard_key } }),
      ),
    ]);
  }

  private stringArray(value: unknown) {
    return Array.isArray(value)
      ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim()))]
      : [];
  }

  private findMediaUrl(value: unknown, depth = 0): string | null {
    if (depth > 6 || !value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    for (const key of [
      'URL',
      'url',
      'mediaUrl',
      'mediaURL',
      'media_url',
      'fileUrl',
      'fileURL',
      'file_url',
      'downloadUrl',
      'downloadURL',
      'download_url',
      'link',
      'href',
    ]) {
      const item = record[key];
      if (typeof item === 'string' && /^https?:\/\//i.test(item)) return item;
    }
    for (const child of Object.values(record)) {
      const found = this.findMediaUrl(child, depth + 1);
      if (found) return found;
    }
    return null;
  }
  private pagination(
    pageValue?: string,
    limitValue?: string,
    defaultLimit = 50,
  ) {
    const page = Math.max(1, Number.parseInt(pageValue || '1', 10) || 1);
    const limit = Math.min(
      100,
      Math.max(
        1,
        Number.parseInt(limitValue || String(defaultLimit), 10) || defaultLimit,
      ),
    );
    return { page, limit, skip: (page - 1) * limit };
  }
  private pageMeta(page: number, limit: number, total: number) {
    return {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrevious: page > 1,
    };
  }
  private baseUrl() {
    return (
      this.config.get<string>('W_API_BASE_URL') || 'https://api.w-api.app'
    ).replace(/\/$/, '');
  }
  private object(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, any>)
      : {};
  }
  private string(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }
  private onlyDigits(value: unknown): string | null {
    const digits = this.string(value)?.replace(/\D/g, '');
    return digits || null;
  }
  private json(value: unknown) {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
