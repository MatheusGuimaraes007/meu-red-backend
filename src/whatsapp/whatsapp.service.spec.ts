import { ConfigService } from '@nestjs/config';
import { WhatsappService } from './whatsapp.service';

type GroupNameResolver = {
  resolveGroupContactName(
    payload: Record<string, unknown>,
    chat: Record<string, unknown>,
    chatId: string,
    instance: Record<string, unknown>,
    existing: { name: string; metadata: unknown } | null,
  ): Promise<{ name: string; providerName?: string; source: string }>;
  extractReplyContext(payload: Record<string, unknown>):
    | {
        external_message_id: string | null;
        participant: string | null;
        content: string;
        message_type: string;
      }
    | undefined;
};

type DeliveryProcessor = {
  processDeliveryWebhook(
    payload: Record<string, unknown>,
    providerInstanceId?: string,
  ): Promise<Record<string, unknown>>;
  processMessageWebhook(
    payload: Record<string, unknown>,
    providerInstanceId?: string,
  ): Promise<Record<string, unknown>>;
};

describe('WhatsappService group names', () => {
  const config = {
    get: jest.fn((name: string) => {
      if (name === 'W_API_BASE_URL') return 'https://api.w-api.app';
      return undefined;
    }),
  } as unknown as ConfigService;
  const service = new WhatsappService(
    {} as never,
    config,
    {} as never,
    {} as never,
  );
  const resolver = service as unknown as GroupNameResolver;
  const instance = {
    provider_instance_id: 'INSTANCE-ID',
    provider_token: 'provider-token',
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves a provisional group name through group-metadata', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: false,
          group: { id: '123@g.us', subject: 'Grupo Comercial' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await resolver.resolveGroupContactName(
      { isGroup: true },
      { id: '123@g.us' },
      '123@g.us',
      instance,
      { name: '123@g.us', metadata: { name_source: 'provisional' } },
    );

    expect(result).toEqual({
      name: 'Grupo Comercial',
      providerName: 'Grupo Comercial',
      source: 'provider',
    });
    const [requestUrl, options] = fetchSpy.mock.calls[0];
    expect(typeof requestUrl).toBe('string');
    if (typeof requestUrl !== 'string') throw new Error('Expected URL string');
    expect(requestUrl).toContain('/v1/group/group-metadata');
    expect(options?.headers).toMatchObject({
      Authorization: 'Bearer provider-token',
    });
  });

  it('preserves a manually edited group name without calling W-API', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');

    const result = await resolver.resolveGroupContactName(
      { isGroup: true },
      { id: '456@g.us' },
      '456@g.us',
      instance,
      { name: 'Clientes VIP', metadata: { name_source: 'manual' } },
    );

    expect(result).toEqual({ name: 'Clientes VIP', source: 'manual' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('accepts group subjects included directly in the webhook', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');

    const result = await resolver.resolveGroupContactName(
      { isGroup: true },
      { id: '789@g.us', subject: 'Equipe RED' },
      '789@g.us',
      instance,
      null,
    );

    expect(result).toEqual({
      name: 'Equipe RED',
      providerName: 'Equipe RED',
      source: 'provider',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    {
      event: 'webhookDelivery',
      stanzaID: 'OUTBOUND-QUOTED-ID',
      participant: '160679491293432@lid',
      quotedText: 'mensagem recebida anteriormente',
      replyText: 'resposta enviada',
    },
    {
      event: 'webhookReceived',
      stanzaID: 'INBOUND-QUOTED-ID',
      participant: '237048271269971@lid',
      quotedText: 'mensagem enviada anteriormente',
      replyText: 'resposta recebida',
    },
  ])(
    'extracts quoted messages from $event payloads',
    ({ event, stanzaID, participant, quotedText, replyText }) => {
      const result = resolver.extractReplyContext({
        event,
        msgContent: {
          extendedTextMessage: {
            text: replyText,
            contextInfo: {
              stanzaID,
              participant,
              quotedMessage: { conversation: quotedText },
            },
          },
        },
      });

      expect(result).toEqual({
        external_message_id: stanzaID,
        participant,
        content: quotedText,
        message_type: 'text',
      });
    },
  );

  it('persists outgoing WhatsApp messages received only as webhookDelivery', async () => {
    const prisma = {
      whatsapp_config: {
        findFirst: jest.fn().mockResolvedValue({ id: 'local-instance-id' }),
      },
      messages: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const deliveryService = new WhatsappService(
      prisma as never,
      config,
      {} as never,
      {} as never,
    );
    const processor = deliveryService as unknown as DeliveryProcessor;
    const persistSpy = jest
      .spyOn(processor, 'processMessageWebhook')
      .mockResolvedValue({ messageId: '2', duplicate: false });
    const payload = {
      event: 'webhookDelivery',
      fromMe: true,
      messageId: 'OUTBOUND-ID',
      msgContent: { conversation: 'enviada pelo celular' },
    };

    const result = await processor.processDeliveryWebhook(
      payload,
      'PROVIDER-INSTANCE-ID',
    );

    expect(persistSpy).toHaveBeenCalledWith(payload, 'PROVIDER-INSTANCE-ID');
    expect(result).toEqual({ messageId: '2', duplicate: false });
  });
});
