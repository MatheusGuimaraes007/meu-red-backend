/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unused-vars */
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { MediaStorageService } from '../media/media-storage.service';
import {
  CreateWhatsappInstanceDto,
  UpdateWhatsappInstanceDto,
} from './dto/whatsapp.dto';

type ProviderPayload = Record<string, any>;

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly groupMetadataCache = new Map<
    string,
    { subject?: string; payload?: ProviderPayload; expiresAt: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly realtime: RealtimeService,
    private readonly mediaStorage: MediaStorageService,
  ) {}

  async createInstance(dto: CreateWhatsappInstanceDto) {
    if (
      dto.useProxy &&
      (!dto.proxyProtocol || !dto.proxyHost || !dto.proxyPort)
    ) {
      throw new BadRequestException(
        'proxyProtocol, proxyHost e proxyPort são obrigatórios com proxy',
      );
    }
    const webhooks = this.webhookUrls();
    const provider = await this.providerRequest('/v1/client/create-instance', {
      method: 'POST',
      body: {
        apiKey: this.required('W_API_API_KEY'),
        instanceName: dto.instanceName,
        lite: dto.lite ?? false,
        ...webhooks,
        automaticReading: dto.automaticReading ?? false,
        rejectCalls: dto.rejectCalls ?? true,
        callMessage:
          dto.callMessage ?? 'Não podemos atender ligações por aqui.',
        useProxy: dto.useProxy ?? false,
        ...(dto.useProxy
          ? {
              proxyProtocol: dto.proxyProtocol,
              proxyHost: dto.proxyHost,
              proxyPort: dto.proxyPort,
              proxyUser: dto.proxyUser,
              proxyPass: dto.proxyPass,
            }
          : {}),
      },
    });
    const providerInstanceId = this.string(provider.instanceId);
    const token = this.string(provider.token);
    if (!providerInstanceId || !token)
      throw new BadGatewayException('W-API não retornou instanceId/token');

    const instance = await this.prisma.whatsapp_config.upsert({
      where: {
        provider_provider_instance_id: {
          provider: 'w_api',
          provider_instance_id: providerInstanceId,
        },
      },
      update: this.instanceData(provider, dto, webhooks, token),
      create: {
        provider: 'w_api',
        provider_instance_id: providerInstanceId,
        ...this.instanceData(provider, dto, webhooks, token),
      },
    });
    return {
      ok: true,
      message: provider.message,
      instance: this.safe(instance),
    };
  }

  async instances(sync = false, user?: { sub: string; role: string }) {
    const warning =
      sync && !this.optional('W_API_API_KEY')
        ? 'W_API_API_KEY não configurada no backend. A listagem local foi carregada; criação, exclusão e sincronização global de instâncias dependem dessa chave no Render.'
        : undefined;
    if (sync && !warning) await this.syncProviderInstances();
    const isAdmin = !user || ['master', 'admin'].includes(user.role);
    const allowed = isAdmin
      ? []
      : await this.prisma.crm_user_instance_permissions.findMany({
          where: { user_id: user.sub },
          select: { whatsapp_config_id: true },
        });
    const rows = await this.prisma.whatsapp_config.findMany({
      where: isAdmin
        ? undefined
        : { id: { in: allowed.map((item) => item.whatsapp_config_id) } },
      orderBy: [{ connected_at: 'desc' }, { updated_at: 'desc' }],
    });
    return {
      ok: true,
      instances: rows.map((row) => this.safe(row)),
      total: rows.length,
      warning,
    };
  }

  async config(id: string) {
    const instance = await this.find(id);
    return { ok: true, instance: this.safe(instance) };
  }

  async updateInstance(id: string, dto: UpdateWhatsappInstanceDto) {
    const current = await this.find(id);
    let providerRename: ProviderPayload | null = null;
    let providerRenameWarning: string | null = null;
    const instanceName = dto.instanceName?.trim();
    if (instanceName && instanceName !== current.instance_name) {
      try {
        const url = new URL('/v1/instance/update-instance-name', this.baseUrl());
        url.searchParams.set('instanceId', this.requiredInstanceId(current));
        providerRename = await this.providerRequest(url.toString(), {
          method: 'PUT',
          token: this.requiredToken(current),
          body: { instanceName },
        });
      } catch (error) {
        providerRenameWarning =
          error instanceof Error
            ? error.message
            : 'O provedor não confirmou a alteração de nome agora.';
      }
    }
    const instance = await this.prisma.whatsapp_config.update({
      where: { id },
      data: {
        instance_name: instanceName,
        display_phone_number: dto.displayPhoneNumber,
        is_active: dto.isActive,
        automatic_reading: dto.automaticReading,
        reject_calls: dto.rejectCalls,
        call_message: dto.callMessage,
        updated_at: new Date(),
      },
    });
    this.emitInstance(instance);
    return {
      ok: true,
      message:
        (providerRenameWarning
          ? 'Nome atualizado no CRM. O provedor não confirmou a alteração agora.'
          : null) ??
        this.string(providerRename?.message) ??
        'Instância atualizada com sucesso.',
      warning: providerRenameWarning,
      instance: this.safe(instance),
    };
  }

  async configureWebhooks(id: string) {
    const instance = await this.find(id);
    const urls = this.webhookUrls();
    const endpoints = [
      ['connected', '/v1/webhook/update-webhook-connected'],
      ['disconnected', '/v1/webhook/update-webhook-disconnected'],
      ['delivery', '/v1/webhook/update-webhook-delivery'],
      ['received', '/v1/webhook/update-webhook-received'],
      ['messageStatus', '/v1/webhook/update-webhook-message-status'],
      ['chatPresence', '/v1/webhook/update-webhook-chat-presence'],
    ] as const;

    const results = await Promise.all(
      endpoints.map(async ([event, path]) => {
        const url = new URL(path, this.baseUrl());
        url.searchParams.set('instanceId', this.requiredInstanceId(instance));
        const response = await this.providerRequest(url.toString(), {
          method: 'PUT',
          token: this.requiredToken(instance),
          body: { value: urls.webhookReceivedUrl },
        });
        return { event, message: this.string(response.message) };
      }),
    );

    const updated = await this.prisma.whatsapp_config.update({
      where: { id },
      data: {
        webhook_connected_url: urls.webhookConnectedUrl,
        webhook_delivery_url: urls.webhookDeliveryUrl,
        webhook_disconnected_url: urls.webhookDisconnectedUrl,
        webhook_status_url: urls.webhookStatusUrl,
        webhook_presence_url: urls.webhookPresenceUrl,
        webhook_received_url: urls.webhookReceivedUrl,
        updated_at: new Date(),
      },
    });

    return {
      ok: true,
      message: 'Webhooks configurados com sucesso.',
      configured: results,
      instance: this.safe(updated),
    };
  }

  async recoverMedia(id: string) {
    const message = await this.prisma.messages.findUnique({
      where: { id: BigInt(id) },
      include: { whatsapp_config: true },
    });
    if (!message?.whatsapp_config)
      throw new NotFoundException('Mensagem ou instância não encontrada');
    const raw = this.record(this.record(message.metadata).raw);
    const media = this.messageContent(raw).media;
    if (!media) throw new BadRequestException('Mensagem não contém mídia');
    const rooms = [
      this.realtime.instance(message.whatsapp_config.id),
      this.realtime.contact(message.contact_id),
    ];
    await this.processIncomingMedia(
      message.id,
      message.whatsapp_config,
      media,
      rooms,
    );
    const updated = await this.prisma.messages.findUnique({
      where: { id: message.id },
    });
    if (!updated)
      throw new BadGatewayException('Falha ao recuperar mídia');
    const mediaUrl =
      (await this.mediaStorage.signedUrl(
        updated.media_storage_bucket,
        updated.media_storage_path,
      )) ?? this.mediaUrlFromRaw(raw);
    if (updated.media_status !== 'completed' && !mediaUrl)
      throw new BadGatewayException(updated?.media_error || 'Falha ao recuperar mídia');
    return {
      ok: true,
      message: {
        ...this.messageForRealtime(updated),
        media_url: mediaUrl,
      },
    };
  }

  async qrCode(id: string, image?: string) {
    const instance = await this.find(id);
    const payload = await this.qrProviderRequest(
      instance,
      image === 'disable' ? 'disable' : 'enable',
    );
    return {
      ok: true,
      instanceId: id,
      providerInstanceId: instance.provider_instance_id,
      image: image === 'disable' ? 'disable' : 'enable',
      qrcode: payload.qrcode ?? payload.qrCode ?? payload.data?.qrcode,
      providerResponse: this.sanitize(payload),
    };
  }

  async pairingCode(id: string, phoneNumber: string) {
    const normalized = phoneNumber?.replace(/\D/g, '');
    if (!normalized) throw new BadRequestException('phoneNumber é obrigatório');
    const instance = await this.find(id);
    const payload = await this.authorizedInstanceRequest(
      '/v1/instance/pairing-code',
      instance,
      { phoneNumber: normalized },
    );
    return {
      ok: true,
      instanceId: id,
      providerInstanceId: instance.provider_instance_id,
      phoneNumber: normalized,
      pairingCode:
        payload.pairingCode ??
        payload.pairing_code ??
        payload.data?.pairingCode,
    };
  }

  async disconnect(id: string) {
    const instance = await this.find(id);
    await this.deleteQueue(id).catch((error) =>
      this.logger.warn(
        `Falha ao limpar fila antes de desconectar ${id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
    const payload = await this.authorizedInstanceRequest(
      '/v1/instance/disconnect',
      instance,
      {},
      'GET',
    );
    const updated = await this.setStatus(instance.id, 'DISCONNECTED', {
      disconnected_at: new Date(),
      is_active: false,
    });
    return { ok: true, message: payload.message, instance: this.safe(updated) };
  }

  async providerStatus(id: string) {
    const instance = await this.find(id);
    const payload = await this.authorizedInstanceRequest(
      '/v1/instance/status-instance',
      instance,
      {},
    );
    const connected = this.boolean(payload.connected) === true;
    const updated = await this.setStatus(instance.id, connected ? 'CONNECTED' : 'DISCONNECTED', {
      is_active: connected,
      ...(connected ? { connected_at: new Date() } : { disconnected_at: new Date() }),
    });
    return {
      ok: true,
      connected,
      provider: this.sanitize(payload),
      instance: this.safe(updated),
    };
  }

  async fetchProviderInstance(id: string) {
    const instance = await this.find(id);
    const payload = await this.authorizedInstanceRequest(
      '/v1/instance/fetch-instance',
      instance,
      {},
    );
    const connected = this.boolean(payload.connected);
    const updated = await this.prisma.whatsapp_config.update({
      where: { id: instance.id },
      data: {
        instance_name: instance.instance_name,
        display_phone_number:
          this.string(payload.connectedPhone) ?? instance.display_phone_number,
        payment_status: this.string(payload.paymentStatus) ?? instance.payment_status,
        expires_at: this.timestamp(payload.expires) ?? instance.expires_at,
        automatic_reading:
          this.boolean(payload.automaticReading) ?? instance.automatic_reading,
        reject_calls: this.boolean(payload.rejectCalls) ?? instance.reject_calls,
        call_message: this.string(payload.callMessage) ?? instance.call_message,
        webhook_connected_url:
          this.string(payload.webhookConnectedUrl) ?? instance.webhook_connected_url,
        webhook_delivery_url:
          this.string(payload.webhookDeliveryUrl) ?? instance.webhook_delivery_url,
        webhook_disconnected_url:
          this.string(payload.webhookDisconnectedUrl) ?? instance.webhook_disconnected_url,
        webhook_status_url:
          this.string(payload.webhookStatusUrl) ?? instance.webhook_status_url,
        webhook_presence_url:
          this.string(payload.webhookPresenceUrl) ?? instance.webhook_presence_url,
        webhook_received_url:
          this.string(payload.webhookReceivedUrl) ?? instance.webhook_received_url,
        ...(connected == null
          ? {}
          : {
              is_active: connected,
              status: connected ? 'CONNECTED' : 'DISCONNECTED',
            }),
        metadata: this.merge(instance.metadata, {
          provider_fetch_at: new Date().toISOString(),
          provider_stats: {
            contacts: payload.contacts ?? null,
            chats: payload.chats ?? null,
            messagesSent: payload.messagesSent ?? null,
            messagesReceived: payload.messagesReceived ?? null,
            syncContacts: payload.syncContacts ?? null,
          },
        }),
        updated_at: new Date(),
      },
    });
    this.emitInstance(updated);
    return {
      ok: true,
      provider: this.sanitize(payload),
      instance: this.safe(updated),
    };
  }

  async queue(id: string, page = 1, perPage = 10) {
    const instance = await this.find(id);
    const payload = await this.authorizedInstanceRequest(
      '/v1/quere/quere',
      instance,
      {
        page: String(Math.max(1, page || 1)),
        perPage: String(Math.max(1, Math.min(100, perPage || 10))),
      },
    );
    return {
      ok: true,
      messages: Array.isArray(payload.messages) ? payload.messages : [],
      totalMessages: Number(payload.totalMessages) || 0,
      totalPages: Number(payload.totalPages) || 1,
      currentPage: Number(payload.currentPage) || page || 1,
    };
  }

  async deleteQueue(id: string) {
    const instance = await this.find(id);
    const payload = await this.authorizedInstanceRequest(
      '/v1/quere/delete-quere',
      instance,
      {},
      'DELETE',
    );
    return {
      ok: true,
      message: this.string(payload.message) ?? 'Fila apagada com sucesso.',
      deletedCount: Number(payload.deletedCount) || 0,
    };
  }

  async deleteQueueMessage(id: string, insertedId: string) {
    if (!insertedId) throw new BadRequestException('insertedId é obrigatório');
    const instance = await this.find(id);
    const payload = await this.authorizedInstanceRequest(
      '/v1/quere/delete-message',
      instance,
      { insertedId },
      'DELETE',
    );
    return {
      ok: true,
      message: this.string(payload.message) ?? 'Mensagem deletada com sucesso.',
    };
  }

  async updateStatus(id: string, status: string) {
    const instance = await this.setStatus(id, status);
    return { ok: true, status, instance: this.safe(instance) };
  }

  async syncGroupNames(id: string) {
    const instance = await this.find(id);
    const groups = await this.prisma.contacts.findMany({
      where: {
        whatsapp_config_id: instance.id,
        phone_number: { endsWith: '@g.us' },
      },
      orderBy: { last_interaction: 'desc' },
    });
    let updated = 0;
    let unresolved = 0;
    let manual = 0;
    let participantsReceived = 0;

    for (const contact of groups) {
      const metadata = this.record(contact.metadata);
      const hasLegacyManualName =
        !metadata.name_source &&
        !this.isProvisionalGroupName(contact.name, contact.phone_number);
      if (metadata.name_source === 'manual' || hasLegacyManualName) {
        manual += 1;
      }
      const result = await this.syncGroupContactMetadata(
        contact,
        instance,
        true,
        !(metadata.name_source === 'manual' || hasLegacyManualName),
      );
      if (!result.synced) {
        unresolved += 1;
        continue;
      }
      updated += 1;
      participantsReceived += result.participantsReceived;
    }

    return {
      ok: true,
      total: groups.length,
      updated,
      unresolved,
      manual,
      participantsReceived,
    };
  }

  async deleteInstance(id: string) {
    const instance = await this.find(id);
    const url = new URL('/v1/client/delete-instance', this.baseUrl());
    url.searchParams.set('instanceId', this.requiredInstanceId(instance));
    await this.providerRequest(url.toString(), {
      method: 'DELETE',
      body: { apiKey: this.required('W_API_API_KEY') },
    });
    const updated = await this.prisma.whatsapp_config.update({
      where: { id },
      data: {
        is_active: false,
        status: 'EXPIRED',
        disconnected_at: new Date(),
        updated_at: new Date(),
        provider_token: null,
      },
    });
    this.emitInstance(updated);
    return { ok: true, instance: this.safe(updated) };
  }

  async webhook(body: unknown, secret?: string) {
    const expected = this.configService.get<string>('WHATSAPP_WEBHOOK_SECRET');
    if (expected && secret !== expected)
      throw new UnauthorizedException('Webhook não autorizado');
    const payload = this.record(body);
    const eventType = this.string(payload.event) ?? 'unknown';
    const providerInstanceId = this.string(payload.instanceId);
    const externalId = this.webhookExternalId(payload);
    const duplicate = externalId
      ? await this.prisma.webhook_events.findFirst({
          where: {
            source: 'w_api',
            external_event_id: externalId,
            status: { in: ['processed', 'duplicate'] },
          },
        })
      : null;
    if (duplicate)
      return { ok: true, duplicate: true, webhookEventId: duplicate.id };

    const event = await this.prisma.webhook_events.create({
      data: {
        source: 'w_api',
        event_type: eventType,
        external_event_id: externalId,
        payload: payload as Prisma.InputJsonValue,
        status: 'received',
      },
    });
    try {
      let result: Record<string, unknown>;
      if (
        [
          'webhookConnected',
          'webhookDisconnected',
          'webhookStatus',
          'webhookPresence',
        ].includes(eventType)
      ) {
        result = await this.processStatusWebhook(payload, providerInstanceId);
      } else if (eventType === 'webhookDelivery') {
        result = await this.processDeliveryWebhook(payload, providerInstanceId);
      } else if (eventType === 'webhookReceived') {
        result = await this.processMessageWebhook(payload, providerInstanceId);
      } else {
        await this.prisma.webhook_events.update({
          where: { id: event.id },
          data: {
            status: 'ignored',
            processed_at: new Date(),
            error: 'Evento W-API não suportado',
          },
        });
        return { ok: true, ignored: true, webhookEventId: event.id };
      }
      await this.prisma.webhook_events.update({
        where: { id: event.id },
        data: { status: 'processed', processed_at: new Date() },
      });
      return { ok: true, webhookEventId: event.id, ...result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.webhook_events.update({
        where: { id: event.id },
        data: {
          status: 'error',
          processed_at: new Date(),
          error: message.slice(0, 2000),
        },
      });
      return {
        ok: true,
        processed: false,
        webhookEventId: event.id,
        error: message,
      };
    }
  }

  private async syncProviderInstances() {
    const url = new URL('/v1/client/list-instances', this.baseUrl());
    url.searchParams.set('apiKey', this.required('W_API_API_KEY'));
    const payload = await this.providerRequest(url.toString());
    const instances = Array.isArray(payload.instances) ? payload.instances : [];
    for (const item of instances) {
      const id = this.string(item.instanceId);
      if (!id) continue;
      await this.prisma.whatsapp_config.upsert({
        where: {
          provider_provider_instance_id: {
            provider: 'w_api',
            provider_instance_id: id,
          },
        },
        create: {
          provider: 'w_api',
          provider_instance_id: id,
          ...this.providerListData(item),
        },
        update: this.providerListUpdateData(item),
      });
    }
  }

  private providerListData(
    item: ProviderPayload,
  ): Prisma.whatsapp_configUncheckedCreateInput {
    return {
      instance_name: this.string(item.instanceName),
      provider_token: this.string(item.token),
      plan_type: this.string(item.planType),
      payment_status: this.string(item.paymentStatus),
      expires_at: this.timestamp(item.expires),
      auto_renew: this.boolean(item.autoRenew),
      is_trial: this.boolean(item.isTrial) ?? false,
      webhook_connected_url: this.string(item.webhookConnectedUrl),
      webhook_delivery_url: this.string(item.webhookDeliveryUrl),
      webhook_disconnected_url: this.string(item.webhookDisconnectedUrl),
      webhook_status_url: this.string(item.webhookStatusUrl),
      webhook_presence_url: this.string(item.webhookPresenceUrl),
      webhook_received_url: this.string(item.webhookReceivedUrl),
      automatic_reading: this.boolean(item.automaticReading) ?? false,
      reject_calls: this.boolean(item.rejectCalls) ?? true,
      call_message: this.string(item.callMessage),
      status: this.string(item.status) ?? 'PENDING',
      metadata: { provider_sync_at: new Date().toISOString() },
      updated_at: new Date(),
    };
  }

  private providerListUpdateData(
    item: ProviderPayload,
  ): Prisma.whatsapp_configUncheckedUpdateInput {
    const { instance_name: _providerName, ...data } = this.providerListData(item);
    return data;
  }

  private instanceData(
    provider: ProviderPayload,
    dto: CreateWhatsappInstanceDto,
    urls: Record<string, string>,
    token: string,
  ): Prisma.whatsapp_configUncheckedCreateInput {
    return {
      provider_token: token,
      instance_name: dto.instanceName,
      status: this.string(provider.status) ?? 'PENDING',
      is_trial: this.boolean(provider.isTrial) ?? true,
      automatic_reading: dto.automaticReading ?? false,
      reject_calls: dto.rejectCalls ?? true,
      call_message: dto.callMessage,
      webhook_connected_url: urls.webhookConnectedUrl,
      webhook_delivery_url: urls.webhookDeliveryUrl,
      webhook_disconnected_url: urls.webhookDisconnectedUrl,
      webhook_status_url: urls.webhookStatusUrl,
      webhook_presence_url: urls.webhookPresenceUrl,
      webhook_received_url: urls.webhookReceivedUrl,
      metadata: {
        provider_message: provider.message ?? null,
        lite: dto.lite ?? false,
      },
      updated_at: new Date(),
    };
  }

  private async processStatusWebhook(
    payload: ProviderPayload,
    providerInstanceId?: string,
  ) {
    const instance = await this.findProvider(providerInstanceId);
    const event = this.string(payload.event);
    const rawStatus = this.string(payload.status)?.toUpperCase();
    const status =
      event === 'webhookConnected'
        ? 'CONNECTED'
        : event === 'webhookDisconnected'
          ? 'DISCONNECTED'
          : (rawStatus ?? 'PENDING');
    const occurredAt =
      this.timestamp(
        payload.moment ? Number(payload.moment) * 1000 : undefined,
      ) ?? new Date();
    const updated = await this.setStatus(instance.id, status, {
      display_phone_number:
        this.string(payload.connectedPhone) ?? instance.display_phone_number,
      last_seen_at: occurredAt,
      ...(status === 'CONNECTED'
        ? { connected_at: occurredAt, is_active: true }
        : {}),
      ...(status === 'DISCONNECTED'
        ? { disconnected_at: occurredAt, is_active: false }
        : {}),
    });
    return { instance: this.safe(updated) };
  }

  private async processDeliveryWebhook(
    payload: ProviderPayload,
    providerInstanceId?: string,
  ) {
    const instance = await this.findProvider(providerInstanceId);
    const externalMessageId = this.string(payload.messageId);
    if (!externalMessageId) throw new BadRequestException('messageId ausente');
    const status = this.deliveryStatus(payload);
    const message = await this.prisma.messages.findFirst({
      where: {
        whatsapp_config_id: instance.id,
        external_message_id: externalMessageId,
      },
      include: { contacts: true },
    });
    if (!message && Object.keys(this.record(payload.msgContent)).length > 0) {
      return this.processMessageWebhook(payload, providerInstanceId);
    }
    if (!message) return { ignored: true, reason: 'Mensagem não encontrada' };
    const replyTo = await this.resolveReplyContext(
      payload,
      instance.id,
      message.contacts,
    );
    const updated = await this.prisma.messages.update({
      where: { id: message.id },
      data: {
        status,
        ...(status === 'read' ? { read_at: new Date() } : {}),
        ...(replyTo
          ? {
              metadata: this.merge(message.metadata, { reply_to: replyTo }),
            }
          : {}),
        updated_at: new Date(),
      },
    });
    const clientMessage = this.messageForRealtime(updated);
    this.realtime.emit('message:status', clientMessage, [
      this.realtime.instance(instance.id),
      this.realtime.contact(updated.contact_id),
    ]);
    if (replyTo) {
      this.realtime.emit('message:updated', clientMessage, [
        this.realtime.instance(instance.id),
        this.realtime.contact(updated.contact_id),
      ]);
    }
    return { messageId: String(updated.id), status };
  }

  private async processMessageWebhook(
    payload: ProviderPayload,
    providerInstanceId?: string,
  ) {
    const instance = await this.findProvider(providerInstanceId);
    const externalMessageId = this.string(payload.messageId);
    const chat = this.record(payload.chat);
    const sender = this.record(payload.sender);
    const chatId = this.string(chat.id);
    if (!externalMessageId || !chatId)
      throw new BadRequestException('Payload de mensagem incompleto');
    const isGroup = payload.isGroup === true && chatId.endsWith('@g.us');
    const fromMe = payload.fromMe === true;
    const phone = isGroup
      ? chatId
      : fromMe
        ? chatId
        : (this.string(sender.id) ?? chatId);
    const aliases = [
      phone,
      chatId,
      this.string(sender.id),
      this.string(sender.phone),
      this.string(sender.number),
      this.string(sender.lid),
    ].filter((value): value is string => Boolean(value));
    const existing = await this.prisma.contacts.findFirst({
      where: {
        whatsapp_config_id: instance.id,
        OR: [
          { phone_number: { in: aliases } },
          ...aliases.flatMap((alias) => [
            { metadata: { path: ['chatId'], equals: alias } },
            { metadata: { path: ['last_sender_id'], equals: alias } },
            { metadata: { path: ['lid'], equals: alias } },
          ]),
        ],
      },
      orderBy: { last_interaction: 'desc' },
    });
    const isFirstIncomingMessage =
      !fromMe &&
      !isGroup &&
      !existing?.crm_funnel_id &&
      (!existing ||
        (await this.prisma.messages.count({
          where: { contact_id: existing.id, role: 'user' },
        })) === 0);
    const automaticEntry = isFirstIncomingMessage
      ? await this.prisma.crm_funnels.findFirst({
          where: {
            whatsapp_config_id: instance.id,
            is_default: true,
            entry_stage_id: { not: null },
          },
          select: { id: true, entry_stage_id: true },
        })
      : null;
    const groupName = isGroup
      ? await this.resolveGroupContactName(
          payload,
          chat,
          chatId,
          instance,
          existing,
        )
      : null;
    const name = isGroup
      ? groupName!.name
      : fromMe
        ? (existing?.name ?? phone)
        : this.first(sender.verifiedBizName, sender.pushName, phone);
    const occurredAt = this.messageTimestamp(payload) ?? new Date();
    const chatProfilePicture = this.firstOptional(
      chat.profilePicture,
      chat.profile_picture,
      chat.picture,
      chat.photo,
      this.record(payload.group).profilePicture,
      this.record(payload.group).profile_picture,
      this.record(payload.group).picture,
      this.record(payload.group).photo,
    );
    const senderProfilePicture = this.firstOptional(
      sender.profilePicture,
      sender.profile_picture,
      sender.picture,
      sender.photo,
    );
    const contactProfilePicture = isGroup
      ? chatProfilePicture
      : fromMe
        ? chatProfilePicture
        : (senderProfilePicture ?? chatProfilePicture);
    const contactMetadata = {
      isGroup,
      chatId,
      needs_reply: !fromMe,
      last_sender_id: this.string(sender.id),
      lid: this.string(sender.lid) ?? (phone.endsWith('@lid') ? phone : null),
      last_sender_name: this.first(sender.pushName, sender.verifiedBizName),
      ...(!fromMe && senderProfilePicture
        ? { last_sender_picture: senderProfilePicture }
        : {}),
      ...(contactProfilePicture
        ? { profile_picture: contactProfilePicture }
        : {}),
      last_message_at: occurredAt.toISOString(),
      ...(isGroup
        ? {
            name_source: groupName!.source,
            provider_chat_name: groupName!.providerName ?? null,
            group_profile_picture: chatProfilePicture ?? null,
            ...(groupName!.providerName
              ? { group_metadata_synced_at: new Date().toISOString() }
              : {}),
          }
        : {}),
    };
    const contact = existing
      ? await this.prisma.contacts.update({
          where: { id: existing.id },
          data: {
            name,
            ...(!isGroup && !fromMe && !phone.endsWith('@lid')
              ? { phone_number: phone }
              : {}),
            last_interaction: occurredAt,
            metadata: this.merge(existing.metadata, contactMetadata),
            ...(automaticEntry?.entry_stage_id
              ? {
                  crm_funnel_id: automaticEntry.id,
                  crm_stage_id: automaticEntry.entry_stage_id,
                }
              : {}),
          },
        })
      : await this.prisma.contacts.create({
          data: {
            whatsapp_config_id: instance.id,
            phone_number: phone,
            name,
            metadata: contactMetadata,
            last_interaction: occurredAt,
            ...(automaticEntry?.entry_stage_id
              ? {
                  crm_funnel_id: automaticEntry.id,
                  crm_stage_id: automaticEntry.entry_stage_id,
                }
              : {}),
          },
        });
    const content = this.messageContent(payload);
    const replyTo = await this.resolveReplyContext(
      payload,
      instance.id,
      contact,
    );
    const existingMessage = await this.prisma.messages.findUnique({
      where: {
        whatsapp_config_id_external_message_id: {
          whatsapp_config_id: instance.id,
          external_message_id: externalMessageId,
        },
      },
    });
    const messageMetadata = this.merge(existingMessage?.metadata, {
      raw: payload,
      isGroup,
      sender_name: this.first(sender.pushName, sender.verifiedBizName),
      sender_id: this.string(sender.id),
      sender_phone: this.firstOptional(
        sender.phone,
        sender.number,
        this.string(sender.id),
      ),
      sender_profile_picture: this.firstOptional(
        sender.profilePicture,
        sender.profile_picture,
        sender.picture,
        sender.photo,
      ),
      participant: this.string(sender.participant),
      ...(replyTo ? { reply_to: replyTo } : {}),
    });
    const message = await this.prisma.messages.upsert({
      where: {
        whatsapp_config_id_external_message_id: {
          whatsapp_config_id: instance.id,
          external_message_id: externalMessageId,
        },
      },
      update: {
        status: fromMe ? 'sent' : 'delivered',
        metadata: messageMetadata,
        updated_at: new Date(),
      },
      create: {
        contact_id: contact.id,
        whatsapp_config_id: instance.id,
        role: fromMe ? 'assistant' : 'user',
        content: content.content,
        message_type: content.type,
        media_mime_type: content.media?.mimeType,
        media_original_name: content.media?.fileName,
        media_size: content.media?.size ? BigInt(content.media.size) : null,
        media_status: content.media ? 'pending' : null,
        external_message_id: externalMessageId,
        status: fromMe ? 'sent' : 'delivered',
        metadata: messageMetadata,
        created_at: occurredAt,
      },
    });
    const rooms = [
      this.realtime.instance(instance.id),
      this.realtime.contact(contact.id),
    ];
    this.realtime.emit(
      existing ? 'contact:updated' : 'contact:created',
      contact as unknown as Record<string, unknown>,
      rooms,
    );
    this.realtime.emit(
      'message:created',
      this.messageForRealtime(message),
      rooms,
    );
    this.realtime.emit(
      existing ? 'conversation:updated' : 'conversation:created',
      {
        contact,
        lastMessage: this.messageForRealtime(message),
      } as unknown as Record<string, unknown>,
      rooms,
    );
    if (content.media && !existingMessage) {
      setImmediate(
        () =>
          void this.processIncomingMedia(
            message.id,
            instance,
            content.media!,
            rooms,
          ),
      );
    }
    if (isGroup && this.shouldSyncGroupParticipants(contact.metadata)) {
      setImmediate(
        () =>
          void this.syncGroupContactMetadata(
            contact,
            instance,
            false,
            groupName!.source !== 'manual',
          ).catch((error) =>
            this.logger.warn(
              `Falha ao sincronizar participantes do grupo ${chatId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          ),
      );
    }
    return {
      contactId: contact.id,
      messageId: String(message.id),
      duplicate: Boolean(existingMessage),
    };
  }

  private async setStatus(
    id: string,
    status: string,
    extra: Prisma.whatsapp_configUpdateInput = {},
  ) {
    const updated = await this.prisma.whatsapp_config.update({
      where: { id },
      data: { ...extra, status, updated_at: new Date() },
    });
    this.emitInstance(updated);
    return updated;
  }
  private emitInstance(instance: any) {
    this.realtime.emit('instance:status', this.safe(instance), [
      this.realtime.instance(instance.id),
    ]);
  }
  private async find(id: string) {
    const row = await this.prisma.whatsapp_config.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Instância não encontrada');
    return row;
  }
  private async findProvider(id?: string) {
    if (!id) throw new BadRequestException('instanceId ausente');
    const row = await this.prisma.whatsapp_config.findFirst({
      where: { provider: 'w_api', provider_instance_id: id },
    });
    if (!row) throw new NotFoundException('Instância W-API não encontrada');
    return row;
  }
  private async authorizedInstanceRequest(
    path: string,
    instance: any,
    query: Record<string, string>,
    method = 'GET',
  ) {
    const url = new URL(path, this.baseUrl());
    url.searchParams.set('instanceId', this.requiredInstanceId(instance));
    Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
    return this.providerRequest(url.toString(), {
      method,
      token: this.requiredToken(instance),
    });
  }
  private async qrProviderRequest(instance: any, image: string) {
    const url = new URL('/v1/instance/qr-code', this.baseUrl());
    url.searchParams.set('instanceId', this.requiredInstanceId(instance));
    url.searchParams.set('image', image);
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.requiredToken(instance)}`,
        Accept: 'application/json,image/png',
      },
    });
    if (!response.ok) {
      const error = await response.text();
      throw new BadGatewayException(
        `W-API QR Code HTTP ${response.status}: ${error.slice(0, 500)}`,
      );
    }
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('image/')) {
      const buffer = Buffer.from(await response.arrayBuffer());
      return {
        qrcode: `data:${contentType.split(';')[0]};base64,${buffer.toString('base64')}`,
      };
    }
    return (await response.json().catch(() => ({}))) as ProviderPayload;
  }
  private async providerRequest(
    pathOrUrl: string,
    options: { method?: string; body?: unknown; token?: string } = {},
  ) {
    const url = pathOrUrl.startsWith('http')
      ? pathOrUrl
      : new URL(pathOrUrl, this.baseUrl()).toString();
    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.token
            ? { Authorization: `Bearer ${options.token}` }
            : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
    } catch (error) {
      throw new BadGatewayException(
        `Falha ao conectar com W-API: ${error instanceof Error ? error.message : error}`,
      );
    }
    const payload = (await response
      .json()
      .catch(() => ({}))) as ProviderPayload;
    if (!response.ok || payload.error === true)
      throw new BadGatewayException({
        message: 'W-API retornou erro',
        statusCode: response.status,
        provider: this.sanitize(payload),
      });
    return payload;
  }
  private webhookUrls() {
    const base = (
      this.optional('W_API_WEBHOOK_BASE_URL') ??
      this.optional('RENDER_EXTERNAL_URL') ??
      (this.optional('NODE_ENV') === 'production'
        ? 'https://crm-red-backend.onrender.com'
        : undefined)
    )?.replace(/\/$/, '');
    if (!base)
      throw new BadRequestException(
        'Configure W_API_WEBHOOK_BASE_URL com a URL pública HTTPS do backend',
      );
    const secret = this.required('WHATSAPP_WEBHOOK_SECRET');
    const url = `${base}/api/whatsapp/webhook?secret=${encodeURIComponent(secret)}`;
    if (!url.startsWith('https://'))
      throw new BadRequestException('A URL pública dos webhooks deve usar HTTPS');
    return {
      webhookConnectedUrl: url,
      webhookDeliveryUrl: url,
      webhookDisconnectedUrl: url,
      webhookStatusUrl: url,
      webhookPresenceUrl: url,
      webhookReceivedUrl: url,
    };
  }
  private safe(instance: any) {
    const {
      provider_token: _token,
      api_key: _key,
      webhook_verify_token: _verify,
      ...safe
    } = instance;
    return safe;
  }
  private sanitize(payload: ProviderPayload) {
    const copy = { ...payload };
    for (const key of ['token', 'apiKey', 'api_key', 'proxyPass'])
      if (key in copy) copy[key] = '[REDACTED]';
    return copy;
  }
  private messageContent(payload: ProviderPayload) {
    const msg = this.messagePayloadContent(payload);
    if (this.string(msg.conversation))
      return { type: 'text', content: msg.conversation };
    if (this.string(this.record(msg.extendedTextMessage).text))
      return {
        type: 'text',
        content: this.record(msg.extendedTextMessage).text,
      };
    for (const [key, type] of [
      ['imageMessage', 'image'],
      ['videoMessage', 'video'],
      ['audioMessage', 'audio'],
      ['stickerMessage', 'sticker'],
      ['documentMessage', 'document'],
    ] as const) {
      const directMedia = this.record(msg[key]);
      const media = Object.keys(directMedia).length
        ? directMedia
        : this.findNestedRecord(msg, key);
      if (Object.keys(media).length)
        return {
          type,
          content: this.first(media.caption, media.fileName, `[${type}]`),
          media: {
            mimeType: this.string(media.mimetype),
            fileName: this.string(media.fileName) ?? this.string(media.title),
            size: Number(media.fileLength) || undefined,
            providerUrl:
              this.string(media.URL) ??
              this.string(media.url) ??
              this.string(media.mediaUrl) ??
              this.string(media.fileUrl) ??
              this.string(media.downloadUrl),
            mediaKey: this.string(media.mediaKey),
            directPath: this.string(media.directPath),
          },
        };
    }
    return { type: 'unknown', content: '[Mensagem não suportada]' };
  }

  private messagePayloadContent(payload: ProviderPayload) {
    const direct = this.record(payload.msgContent);
    if (Object.keys(direct).length) return direct;
    const message = this.record(payload.message);
    if (Object.keys(message).length) return message;
    const dataMessage = this.record(this.record(payload.data).message);
    if (Object.keys(dataMessage).length) return dataMessage;
    return {};
  }

  private findNestedRecord(
    value: unknown,
    key: string,
    depth = 0,
  ): ProviderPayload {
    if (depth > 4 || !value || typeof value !== 'object') return {};
    const record = this.record(value);
    const match = this.record(record[key]);
    if (Object.keys(match).length) return match;
    for (const child of Object.values(record)) {
      const found = this.findNestedRecord(child, key, depth + 1);
      if (Object.keys(found).length) return found;
    }
    return {};
  }

  private async resolveReplyContext(
    payload: ProviderPayload,
    whatsappConfigId: string,
    contact: { name: string },
  ) {
    const reference = this.extractReplyContext(payload);
    if (!reference) return undefined;
    const original = reference.external_message_id
      ? await this.prisma.messages.findFirst({
          where: {
            whatsapp_config_id: whatsappConfigId,
            external_message_id: reference.external_message_id,
          },
        })
      : null;
    const originalMetadata = this.record(original?.metadata);
    const participantIsMe =
      this.sameWhatsappIdentity(
        reference.participant,
        this.string(payload.connectedLid),
      ) ||
      this.sameWhatsappIdentity(
        reference.participant,
        this.string(payload.connectedPhone),
      );
    const role = original?.role ?? (participantIsMe ? 'assistant' : 'user');
    const quotedType =
      reference.message_type === 'unknown'
        ? (original?.message_type ?? 'unknown')
        : reference.message_type;
    const quotedContent =
      reference.message_type === 'unknown' && original?.content
        ? original.content
        : reference.content;

    return {
      message_id: original ? String(original.id) : null,
      external_message_id: reference.external_message_id,
      participant: reference.participant,
      role,
      sender_name:
        role === 'assistant'
          ? 'Você'
          : (this.string(originalMetadata.sender_name) ?? contact.name),
      content: quotedContent,
      message_type: quotedType,
    };
  }

  private extractReplyContext(payload: ProviderPayload) {
    const msg = this.record(payload.msgContent);
    const contexts = [
      this.record(msg.contextInfo),
      this.record(msg.messageContextInfo),
      ...Object.values(msg).map((value) =>
        this.record(this.record(value).contextInfo),
      ),
      ...this.findQuotedContexts(payload),
    ];
    const context = contexts.find(
      (candidate) =>
        Object.keys(this.record(candidate.quotedMessage)).length > 0,
    );
    if (!context) return undefined;
    const quoted = this.record(context.quotedMessage);
    const content = this.messageContent({ msgContent: quoted });
    return {
      external_message_id:
        this.string(context.stanzaID) ??
        this.string(context.stanzaId) ??
        this.string(context.quotedStanzaID) ??
        this.string(context.messageId) ??
        null,
      participant: this.string(context.participant) ?? null,
      content: content.content,
      message_type: content.type,
    };
  }

  private findQuotedContexts(value: unknown, depth = 0): ProviderPayload[] {
    if (depth > 6 || !value || typeof value !== 'object') return [];
    const record = this.record(value);
    const found = Object.keys(this.record(record.quotedMessage)).length
      ? [record]
      : [];
    return found.concat(
      Object.values(record).flatMap((child) =>
        this.findQuotedContexts(child, depth + 1),
      ),
    );
  }

  private sameWhatsappIdentity(first?: string | null, second?: string | null) {
    if (!first || !second) return false;
    return first === second || first.split('@')[0] === second.split('@')[0];
  }

  private messageForRealtime(message: ProviderPayload) {
    const metadata = this.record(message.metadata);
    const replyTo = this.record(metadata.reply_to);
    const mediaUrl = this.mediaUrlFromRaw(this.record(metadata.raw));
    const attachment = this.messageAttachmentForRealtime(message, mediaUrl);
    return {
      ...message,
      reply_to: Object.keys(replyTo).length > 0 ? replyTo : null,
      ...(mediaUrl ? { media_url: mediaUrl } : {}),
      attachments: attachment ? [attachment] : [],
    } as Record<string, unknown>;
  }

  private messageAttachmentForRealtime(message: ProviderPayload, url: string | null) {
    const type = this.string(message.message_type)?.toLowerCase() ?? '';
    if (!['image', 'video', 'audio', 'document', 'sticker', 'gif'].includes(type))
      return null;
    const status = this.string(message.media_status) ?? (url ? 'completed' : 'pending');
    return {
      id: String(message.id ?? message.external_message_id ?? ''),
      type,
      mimeType: this.string(message.media_mime_type) ?? null,
      fileName: this.string(message.media_original_name) ?? null,
      fileSize:
        typeof message.media_size === 'bigint'
          ? Number(message.media_size)
          : (Number(message.media_size) || null),
      status,
      statusLabel: this.mediaStatusLabel(status),
      error: this.string(message.media_error) ?? null,
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

  private mediaUrlFromRaw(raw: ProviderPayload) {
    return this.findMediaUrl(raw);
  }

  private findMediaUrl(value: unknown, depth = 0): string | null {
    if (depth > 6 || !value || typeof value !== 'object') return null;
    const record = this.record(value);
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

  private async processIncomingMedia(
    messageId: bigint,
    instance: any,
    media: {
      mimeType?: string;
      fileName?: string;
      providerUrl?: string;
      mediaKey?: string;
      directPath?: string;
    },
    rooms: string[],
  ) {
    try {
      const stored = await this.mediaStorage.storeIncoming(messageId, {
        providerInstanceId: this.requiredInstanceId(instance),
        providerToken: this.requiredToken(instance),
        type:
          (
            await this.prisma.messages.findUnique({
              where: { id: messageId },
              select: { message_type: true },
            })
          )?.message_type ?? 'document',
        mimeType: media.mimeType,
        fileName: media.fileName,
        providerUrl: media.providerUrl,
        mediaKey: media.mediaKey,
        directPath: media.directPath,
      });
      const message = await this.prisma.messages.update({
        where: { id: messageId },
        data: {
          media_storage_bucket: stored.bucket,
          media_storage_path: stored.path,
          media_mime_type: stored.mimeType,
          media_extension: stored.extension,
          media_original_name: stored.originalName,
          media_size: BigInt(stored.size),
          media_status: 'completed',
          media_error: null,
          updated_at: new Date(),
        },
      });
      const attachment = this.messageAttachmentForRealtime(message, stored.url);
      this.realtime.emit(
        'message:updated',
        {
          ...this.messageForRealtime(message),
          media_url: stored.url,
          attachments: attachment ? [attachment] : [],
        },
        rooms,
      );
    } catch (error) {
      const message = await this.prisma.messages.update({
        where: { id: messageId },
        data: {
          media_status: 'failed',
          media_error: (error instanceof Error
            ? error.message
            : String(error)
          ).slice(0, 2000),
          updated_at: new Date(),
        },
      });
      this.realtime.emit(
        'message:updated',
        this.messageForRealtime(message),
        rooms,
      );
    }
  }

  private async resolveGroupContactName(
    payload: ProviderPayload,
    chat: ProviderPayload,
    chatId: string,
    instance: ProviderPayload,
    existing: { name: string; metadata: unknown } | null,
  ) {
    const currentMetadata = this.record(existing?.metadata);
    if (existing && currentMetadata.name_source === 'manual') {
      return { name: existing.name, source: 'manual' as const };
    }

    const inlineName = this.firstOptional(
      chat.name,
      chat.subject,
      chat.pushName,
      chat.groupName,
      payload.groupName,
      this.record(payload.group).name,
      this.record(payload.group).subject,
    );
    const shouldFetch =
      !inlineName &&
      (!existing || this.isProvisionalGroupName(existing.name, chatId));
    const fetchedName = shouldFetch
      ? await this.resolveGroupSubject(instance, chatId)
      : undefined;
    const providerName = inlineName ?? fetchedName;

    if (providerName) {
      return {
        name: providerName,
        providerName,
        source: 'provider' as const,
      };
    }
    if (existing && !this.isProvisionalGroupName(existing.name, chatId)) {
      const providerName = this.string(currentMetadata.provider_chat_name);
      return {
        name: existing.name,
        providerName,
        source:
          currentMetadata.name_source === 'provider'
            ? ('provider' as const)
            : ('manual' as const),
      };
    }
    return { name: chatId, source: 'provisional' as const };
  }

  private async syncGroupContactMetadata(
    contact: { id: string; name: string; phone_number: string; metadata: unknown },
    instance: ProviderPayload,
    force = false,
    updateName = true,
  ) {
    const metadata = await this.fetchGroupMetadata(
      instance,
      contact.phone_number,
      force,
    );
    const group = this.record(metadata.group);
    if (!Object.keys(group).length) return { synced: false, participantsReceived: 0 };

    const syncedAt = new Date().toISOString();
    const subject = this.firstOptional(group.subject, group.name);
    const groupProfilePicture = this.firstOptional(
      group.profilePicture,
      group.profile_picture,
      group.picture,
      group.photo,
      group.image,
      group.avatar,
    );
    const participants = this.groupParticipants(group.participants);
    const nextMetadata = this.merge(contact.metadata, {
      isGroup: true,
      chatId: contact.phone_number,
      group_profile_picture: groupProfilePicture ?? null,
      profile_picture: groupProfilePicture ?? null,
      ...(updateName && subject
        ? { name_source: 'provider', provider_chat_name: subject }
        : {}),
      group_metadata_synced_at: syncedAt,
      group_members_synced_at: syncedAt,
      group_owner: this.string(group.owner) ?? null,
      group_subject_owner: this.string(group.subjectOwner) ?? null,
      group_subject_time: group.subjectTime ?? null,
      group_creation: group.creation ?? null,
      group_restrict: group.restrict ?? null,
      group_announce: group.announce ?? null,
      group_invite_link: this.string(group.inviteLink) ?? null,
      group_size: Number(group.size) || participants.length,
      group_participants: participants,
    });

    const synced = await this.prisma.contacts.update({
      where: { id: contact.id },
      data: {
        ...(updateName && subject ? { name: subject } : {}),
        metadata: nextMetadata,
      },
    });
    this.emitGroupContactUpdated(synced);
    return { synced: true, participantsReceived: participants.length };
  }

  private shouldSyncGroupParticipants(metadata: unknown) {
    const value = this.record(metadata);
    const participants = value.group_participants;
    if (!Array.isArray(participants) || participants.length === 0) return true;
    const syncedAt = this.string(value.group_members_synced_at);
    if (!syncedAt) return true;
    const time = Date.parse(syncedAt);
    if (!Number.isFinite(time)) return true;
    return Date.now() - time > 12 * 60 * 60 * 1000;
  }

  private groupParticipants(value: unknown) {
    const list = Array.isArray(value) ? value : [];
    return list
      .map((item) => {
        const participant = this.record(item);
        const phone = this.string(participant.phone);
        const lid = this.string(participant.lid);
        const id = phone ?? lid;
        if (!id) return null;
        const name = this.firstOptional(
          participant.short,
          participant.name,
          participant.pushName,
          participant.verifiedBizName,
        );
        const profilePicture = this.firstOptional(
          participant.profilePicture,
          participant.profile_picture,
          participant.picture,
          participant.photo,
        );
        return {
          id,
          phone: phone ?? null,
          lid: lid ?? null,
          name: name ?? phone ?? lid ?? null,
          profilePicture: profilePicture ?? null,
          isAdmin: participant.isAdmin === true,
          isSuperAdmin: participant.isSuperAdmin === true,
          role: participant.isSuperAdmin === true ? 'super_admin' : participant.isAdmin === true ? 'admin' : 'member',
        };
      })
      .filter(Boolean);
  }

  private async resolveGroupSubject(
    instance: ProviderPayload,
    groupId: string,
    force = false,
  ) {
    const providerInstanceId = this.requiredInstanceId(instance);
    const cacheKey = `${providerInstanceId}:${groupId}`;
    const cached = this.groupMetadataCache.get(cacheKey);
    if (!force && cached && cached.expiresAt > Date.now()) {
      return cached.subject;
    }

    try {
      const payload = await this.fetchGroupMetadata(instance, groupId, force);
      const group = this.record(payload.group);
      const subject = this.firstOptional(group.subject, group.name);
      this.groupMetadataCache.set(cacheKey, {
        subject,
        expiresAt: Date.now() + (subject ? 12 * 60 * 60 * 1000 : 5 * 60 * 1000),
      });
      return subject;
    } catch (error) {
      this.groupMetadataCache.set(cacheKey, {
        expiresAt: Date.now() + 5 * 60 * 1000,
      });
      this.logger.warn(
        `Falha ao sincronizar metadata do grupo ${groupId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  private async fetchGroupMetadata(
    instance: ProviderPayload,
    groupId: string,
    force = false,
  ) {
    const providerInstanceId = this.requiredInstanceId(instance);
    const cacheKey = `${providerInstanceId}:${groupId}:payload`;
    const cached = this.groupMetadataCache.get(cacheKey);
    if (!force && cached?.payload && cached.expiresAt > Date.now()) {
      return cached.payload;
    }
    const url = new URL('/v1/group/group-metadata', this.baseUrl());
    url.searchParams.set('instanceId', providerInstanceId);
    url.searchParams.set('groupId', groupId);
    const payload = await this.providerRequest(url.toString(), {
      token: this.requiredToken(instance),
    });
    this.groupMetadataCache.set(cacheKey, {
      payload,
      expiresAt: Date.now() + 12 * 60 * 60 * 1000,
    });
    return payload;
  }

  private isProvisionalGroupName(name: string, chatId: string) {
    const value = name.trim();
    return (
      value === chatId ||
      value.endsWith('@g.us') ||
      value === chatId.replace(/@g\.us$/, '')
    );
  }

  private emitGroupContactUpdated(contact: ProviderPayload) {
    const rooms = [
      this.realtime.instance(String(contact.whatsapp_config_id)),
      this.realtime.contact(String(contact.id)),
    ];
    this.realtime.emit('contact:updated', contact, rooms);
    this.realtime.emit('conversation:updated', { contact }, rooms);
  }
  private deliveryStatus(payload: ProviderPayload) {
    const value = String(
      payload.status ?? payload.ack ?? payload.messageStatus ?? '',
    ).toLowerCase();
    if (value.includes('read') || value === '3') return 'read';
    if (value.includes('deliver') || value === '2') return 'delivered';
    if (value.includes('fail') || value.includes('error')) return 'failed';
    return 'sent';
  }
  private webhookExternalId(payload: ProviderPayload) {
    const message = this.string(payload.messageId);
    if (message)
      return `${this.string(payload.event) ?? 'event'}:${this.string(payload.instanceId) ?? ''}:${message}`;
    const moment = payload.moment;
    return moment
      ? `${this.string(payload.event) ?? 'event'}:${this.string(payload.instanceId) ?? ''}:${moment}`
      : undefined;
  }
  private merge(current: unknown, update: Record<string, unknown>) {
    return {
      ...(current && typeof current === 'object' && !Array.isArray(current)
        ? (current as object)
        : {}),
      ...update,
    } as Prisma.InputJsonObject;
  }
  private required(name: string) {
    const value = this.configService.get<string>(name)?.trim();
    if (!value)
      throw new ServiceUnavailableException(
        `Configuração obrigatória ausente no backend: ${name}`,
      );
    return value;
  }
  private optional(name: string) {
    return this.configService.get<string>(name)?.trim() || null;
  }
  private baseUrl() {
    return (
      this.configService.get<string>('W_API_BASE_URL') ??
      'https://api.w-api.app'
    ).replace(/\/$/, '');
  }
  private requiredInstanceId(instance: any) {
    if (!instance.provider_instance_id)
      throw new BadRequestException('Instância sem provider_instance_id');
    return instance.provider_instance_id;
  }
  private requiredToken(instance: any) {
    if (!instance.provider_token)
      throw new BadRequestException('Instância sem provider_token');
    return instance.provider_token;
  }
  private record(value: unknown): ProviderPayload {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as ProviderPayload)
      : {};
  }
  private string(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }
  private boolean(value: unknown) {
    return typeof value === 'boolean' ? value : undefined;
  }
  private first(...values: unknown[]) {
    return (
      values.find(
        (value): value is string =>
          typeof value === 'string' && value.trim().length > 0,
      ) ?? ''
    );
  }
  private firstOptional(...values: unknown[]) {
    return values
      .find(
        (value): value is string =>
          typeof value === 'string' && value.trim().length > 0,
      )
      ?.trim();
  }
  private timestamp(value: unknown) {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) return undefined;
    const date = new Date(number);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  private messageTimestamp(payload: ProviderPayload) {
    const raw =
      payload.moment ??
      payload.timestamp ??
      payload.messageTimestamp ??
      this.record(payload.message).messageTimestamp;
    const number = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(number)) return undefined;
    return this.timestamp(number < 10_000_000_000 ? number * 1000 : number);
  }
}
