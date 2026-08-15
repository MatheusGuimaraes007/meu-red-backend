import { ConfigService } from '@nestjs/config';
import { WhatsappService } from './whatsapp.service';

// Fixtures reais extraidas de RELATORIO_TECNICO_WEBHOOKS_IDENTIDADE_CRM_RED.
const INSTANCE_ID = 'instance-1';
const PROVIDER_INSTANCE_ID = 'PROVIDER-ID';
const KAROLLAINE_PHONE = '5515991059882';
const KAROLLAINE_LID = '224734214103271@lid';
const THELL_PHONE = '5511965105122';
const THELL_LID = '96890234347665@lid';
const RED_ACCOUNT_ID = '110346517934287';
const RED_ACCOUNT_LID = '110346517934287@lid';
const GROUP_ID = '120363395697918524@g.us';

type FakeContact = {
  id: string;
  whatsapp_config_id: string;
  phone_number: string;
  name: string;
  metadata: Record<string, unknown>;
  crm_funnel_id: string | null;
  crm_stage_id: string | null;
  last_interaction: Date;
};

function matchLeaf(contact: FakeContact, cond: any): boolean {
  if (cond.phone_number !== undefined)
    return contact.phone_number === cond.phone_number;
  if (cond.metadata?.path)
    return contact.metadata[cond.metadata.path[0]] === cond.metadata.equals;
  return true;
}

function matchesWhere(contact: FakeContact, where: any): boolean {
  if (
    where.whatsapp_config_id &&
    contact.whatsapp_config_id !== where.whatsapp_config_id
  )
    return false;
  if (where.phone_number !== undefined && !matchLeaf(contact, where))
    return false;
  if (where.OR) return where.OR.some((cond: any) => matchLeaf(contact, cond));
  return true;
}

function makeFakePrisma(initialContacts: FakeContact[] = []) {
  const contactsDb = [...initialContacts];
  const messagesDb: any[] = [];
  let nextMessageId = 1n;

  const prisma = {
    whatsapp_config: {
      findFirst: jest.fn().mockResolvedValue({
        id: INSTANCE_ID,
        provider_instance_id: PROVIDER_INSTANCE_ID,
        provider_token: 'provider-token',
      }),
    },
    contacts: {
      findFirst: jest.fn(async ({ where }: any) => {
        const matches = contactsDb.filter((c) => matchesWhere(c, where));
        if (!matches.length) return null;
        return matches.sort(
          (a, b) => b.last_interaction.getTime() - a.last_interaction.getTime(),
        )[0];
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const idx = contactsDb.findIndex((c) => c.id === where.id);
        const current = contactsDb[idx];
        const updated = {
          ...current,
          ...data,
          metadata:
            data.metadata !== undefined ? data.metadata : current.metadata,
        };
        contactsDb[idx] = updated;
        return updated;
      }),
      create: jest.fn(async ({ data }: any) => {
        const created: FakeContact = {
          id: `contact-${contactsDb.length + 1}`,
          crm_funnel_id: null,
          crm_stage_id: null,
          last_interaction: new Date(),
          ...data,
        };
        contactsDb.push(created);
        return created;
      }),
    },
    messages: {
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn(async ({ where }: any) => {
        return (
          messagesDb.find(
            (m) =>
              (!where.whatsapp_config_id ||
                m.whatsapp_config_id === where.whatsapp_config_id) &&
              (!where.external_message_id ||
                m.external_message_id === where.external_message_id) &&
              (!where.contact_id || m.contact_id === where.contact_id),
          ) ?? null
        );
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const key = where.whatsapp_config_id_external_message_id;
        if (!key) return null;
        return (
          messagesDb.find(
            (m) =>
              m.whatsapp_config_id === key.whatsapp_config_id &&
              m.external_message_id === key.external_message_id,
          ) ?? null
        );
      }),
      upsert: jest.fn(async ({ where, update, create }: any) => {
        const key = where.whatsapp_config_id_external_message_id;
        const idx = messagesDb.findIndex(
          (m) =>
            m.whatsapp_config_id === key.whatsapp_config_id &&
            m.external_message_id === key.external_message_id,
        );
        if (idx >= 0) {
          messagesDb[idx] = { ...messagesDb[idx], ...update };
          return messagesDb[idx];
        }
        const created = { id: nextMessageId, ...create };
        nextMessageId += 1n;
        messagesDb.push(created);
        return created;
      }),
    },
    crm_funnels: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  return { prisma, contactsDb, messagesDb };
}

function makeRealtime() {
  return {
    emit: jest.fn(),
    instance: (id: string) => `instance:${id}`,
    contact: (id: string) => `contact:${id}`,
  };
}

const config = {
  get: jest.fn((name: string) => {
    if (name === 'W_API_BASE_URL') return 'https://api.w-api.app';
    return undefined;
  }),
} as unknown as ConfigService;

type Processor = {
  processMessageWebhook(
    payload: Record<string, unknown>,
    providerInstanceId?: string,
  ): Promise<{ contactId: string; messageId: string; duplicate: boolean }>;
};

describe('WhatsappService - resolução de identidade (regressão Karollaine/ThellTorres)', () => {
  it('cria o contato da Karollaine com telefone e LID corretos em mensagem privada recebida', async () => {
    const { prisma, contactsDb } = makeFakePrisma([]);
    const service = new WhatsappService(
      prisma as never,
      config,
      makeRealtime() as never,
      {} as never,
    );
    const processor = service as unknown as Processor;

    await processor.processMessageWebhook(
      {
        event: 'webhookReceived',
        fromMe: false,
        messageId: 'MSG-KAROL-1',
        chat: { id: KAROLLAINE_LID, profilePicture: 'https://cdn/karol-chat.jpg' },
        sender: {
          id: KAROLLAINE_PHONE,
          senderLid: KAROLLAINE_LID,
          pushName: 'Karollaine',
          profilePicture: 'https://cdn/karol-sender.jpg',
        },
        msgContent: { conversation: 'Oi!' },
      },
      PROVIDER_INSTANCE_ID,
    );

    expect(contactsDb).toHaveLength(1);
    expect(contactsDb[0].phone_number).toBe(KAROLLAINE_PHONE);
    expect(contactsDb[0].metadata.lid).toBe(KAROLLAINE_LID);
    expect(contactsDb[0].metadata.profile_picture).toBe(
      'https://cdn/karol-chat.jpg',
    );
  });

  it('NAO anexa a resposta enviada ao ThellTorres no contato da Karollaine, mesmo com last_sender_id da RED contaminando o metadata dela', async () => {
    const now = new Date();
    const karollaine: FakeContact = {
      id: 'contact-karollaine',
      whatsapp_config_id: INSTANCE_ID,
      phone_number: KAROLLAINE_PHONE,
      name: 'Karollaine',
      // Cenario real: a RED respondeu a Karollaine antes, entao seu metadata
      // tem last_sender_id = ID da conta RED (metadado operacional legitimo).
      metadata: { lid: KAROLLAINE_LID, last_sender_id: RED_ACCOUNT_ID },
      crm_funnel_id: null,
      crm_stage_id: null,
      last_interaction: now,
    };
    const thell: FakeContact = {
      id: 'contact-thell',
      whatsapp_config_id: INSTANCE_ID,
      phone_number: THELL_PHONE,
      name: 'Terapeuta ThellTorres',
      metadata: { lid: THELL_LID },
      crm_funnel_id: null,
      crm_stage_id: null,
      last_interaction: now,
    };
    const { prisma, contactsDb, messagesDb } = makeFakePrisma([
      karollaine,
      thell,
    ]);
    const service = new WhatsappService(
      prisma as never,
      config,
      makeRealtime() as never,
      {} as never,
    );
    const processor = service as unknown as Processor;

    // Payload real: resposta da RED para o Thell (fromMe=true).
    const result = await processor.processMessageWebhook(
      {
        event: 'webhookReceived',
        fromMe: true,
        messageId: 'A5C2F930F2D1942C4F014483C8BF2E3B',
        chat: { id: THELL_LID },
        sender: { id: RED_ACCOUNT_ID, senderLid: RED_ACCOUNT_LID },
        msgContent: { conversation: 'Ola, Bom dia!... Me chamo Victor...' },
      },
      PROVIDER_INSTANCE_ID,
    );

    expect(result.contactId).toBe('contact-thell');
    const persisted = messagesDb.find(
      (m) => m.external_message_id === 'A5C2F930F2D1942C4F014483C8BF2E3B',
    );
    expect(persisted.contact_id).toBe('contact-thell');

    // Karollaine nao pode ter sido tocada por essa mensagem.
    const karollaineAfter = contactsDb.find((c) => c.id === 'contact-karollaine')!;
    expect(karollaineAfter.name).toBe('Karollaine');
    expect(prisma.contacts.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'contact-karollaine' } }),
    );
  });

  it('NAO aceita o LID numerico duplicado como telefone (evento B do messageId duplicado)', async () => {
    const { prisma, contactsDb } = makeFakePrisma([]);
    const service = new WhatsappService(
      prisma as never,
      config,
      makeRealtime() as never,
      {} as never,
    );
    const processor = service as unknown as Processor;
    const numericLid = THELL_LID.replace('@lid', '');

    await processor.processMessageWebhook(
      {
        event: 'webhookReceived',
        fromMe: false,
        messageId: 'ACC926B584FC91856E8DD81403136C76',
        chat: { id: THELL_LID },
        // sender.id igual aos digitos do proprio LID (bug real observado).
        sender: { id: numericLid, senderLid: THELL_LID, pushName: 'Thell' },
        msgContent: { conversation: 'Bom dia!' },
      },
      PROVIDER_INSTANCE_ID,
    );

    expect(contactsDb).toHaveLength(1);
    // phone_number deve cair para o LID, nunca para o numero identico ao LID.
    expect(contactsDb[0].phone_number).toBe(THELL_LID);
  });

  it('mensagem de grupo com Karollaine como sender nao toca no contato privado dela', async () => {
    const now = new Date();
    const karollaine: FakeContact = {
      id: 'contact-karollaine',
      whatsapp_config_id: INSTANCE_ID,
      phone_number: KAROLLAINE_PHONE,
      name: 'Karollaine',
      metadata: { lid: KAROLLAINE_LID },
      crm_funnel_id: null,
      crm_stage_id: null,
      last_interaction: now,
    };
    const { prisma, contactsDb } = makeFakePrisma([karollaine]);
    const service = new WhatsappService(
      prisma as never,
      config,
      makeRealtime() as never,
      {} as never,
    );
    const processor = service as unknown as Processor;

    await processor.processMessageWebhook(
      {
        event: 'webhookReceived',
        isGroup: true,
        fromMe: false,
        messageId: 'MSG-GROUP-1',
        chat: { id: GROUP_ID, subject: 'Grupo Comercial' },
        sender: { id: KAROLLAINE_PHONE, senderLid: KAROLLAINE_LID, pushName: 'Karollaine' },
        msgContent: { conversation: 'Mensagem no grupo' },
      },
      PROVIDER_INSTANCE_ID,
    );

    expect(prisma.contacts.update).not.toHaveBeenCalled();
    const group = contactsDb.find((c) => c.phone_number === GROUP_ID);
    expect(group).toBeDefined();
    expect(group!.id).not.toBe('contact-karollaine');
    const karollaineAfter = contactsDb.find((c) => c.id === 'contact-karollaine')!;
    expect(karollaineAfter.metadata.isGroup).toBeUndefined();
  });

  it('nao sobrescreve nome definido manualmente', async () => {
    const now = new Date();
    const manual: FakeContact = {
      id: 'contact-manual',
      whatsapp_config_id: INSTANCE_ID,
      phone_number: THELL_PHONE,
      name: 'Nome Definido Pelo Atendente',
      metadata: { lid: THELL_LID, name_source: 'manual' },
      crm_funnel_id: null,
      crm_stage_id: null,
      last_interaction: now,
    };
    const { prisma, contactsDb } = makeFakePrisma([manual]);
    const service = new WhatsappService(
      prisma as never,
      config,
      makeRealtime() as never,
      {} as never,
    );
    const processor = service as unknown as Processor;

    await processor.processMessageWebhook(
      {
        event: 'webhookReceived',
        fromMe: false,
        messageId: 'MSG-MANUAL-1',
        chat: { id: THELL_LID },
        sender: { id: THELL_PHONE, senderLid: THELL_LID, pushName: 'Outro Nome Do WhatsApp' },
        msgContent: { conversation: 'Oi de novo' },
      },
      PROVIDER_INSTANCE_ID,
    );

    void prisma;
    const after = contactsDb.find((c) => c.id === 'contact-manual')!;
    expect(after.name).toBe('Nome Definido Pelo Atendente');
  });

  it('reply nao cruza contatos diferentes (mantém apenas o texto citado)', async () => {
    const now = new Date();
    const karollaine: FakeContact = {
      id: 'contact-karollaine',
      whatsapp_config_id: INSTANCE_ID,
      phone_number: KAROLLAINE_PHONE,
      name: 'Karollaine',
      metadata: { lid: KAROLLAINE_LID },
      crm_funnel_id: null,
      crm_stage_id: null,
      last_interaction: now,
    };
    const thell: FakeContact = {
      id: 'contact-thell',
      whatsapp_config_id: INSTANCE_ID,
      phone_number: THELL_PHONE,
      name: 'Terapeuta ThellTorres',
      metadata: { lid: THELL_LID },
      crm_funnel_id: null,
      crm_stage_id: null,
      last_interaction: now,
    };
    const { prisma, contactsDb, messagesDb } = makeFakePrisma([
      karollaine,
      thell,
    ]);
    // Mensagem original historica pertence (por engano, cenario legado) a Karollaine.
    messagesDb.push({
      id: 99n,
      whatsapp_config_id: INSTANCE_ID,
      contact_id: 'contact-karollaine',
      external_message_id: 'STANZA-ORIGINAL',
      role: 'user',
      content: 'pergunta original',
      message_type: 'text',
      metadata: {},
    });
    const service = new WhatsappService(
      prisma as never,
      config,
      makeRealtime() as never,
      {} as never,
    );
    const processor = service as unknown as Processor;

    const result = await processor.processMessageWebhook(
      {
        event: 'webhookReceived',
        fromMe: true,
        messageId: 'A5554A737A17DD88E3B091406B1159C7',
        chat: { id: THELL_LID },
        sender: { id: RED_ACCOUNT_ID, senderLid: RED_ACCOUNT_LID },
        msgContent: {
          extendedTextMessage: {
            text: 'Seria incrivel...',
            contextInfo: {
              stanzaID: 'STANZA-ORIGINAL',
              quotedMessage: { conversation: 'pergunta original' },
            },
          },
        },
      },
      PROVIDER_INSTANCE_ID,
    );

    expect(result.contactId).toBe('contact-thell');
    const persisted = messagesDb.find(
      (m) => m.external_message_id === 'A5554A737A17DD88E3B091406B1159C7',
    );
    const replyTo = (persisted.metadata as any).reply_to;
    expect(replyTo.message_id).toBeNull();
    expect(replyTo.content).toBe('pergunta original');
  });
});
