import { CrmService } from './crm.service';

// Fase 3: autorizacao de envio por card (bloqueia vendedor que perdeu o
// lead, mesmo que o frontend nao desabilite o botao). Ver
// PROMPT_CODEX_ATUALIZACOES_CRM_PIPELINES_AUTOMACOES_CSV, secao
// "AUTORIZACAO DE ENVIO DE MENSAGEM".

const CONTACT_ID = 'contact-1';
const VICTOR = { sub: 'user-victor', role: 'agent' };
const JOAO = { sub: 'user-joao', role: 'agent' };
const MARIA = { sub: 'user-maria', role: 'agent' };
const ADMIN = { sub: 'user-admin', role: 'admin' };

function makeService(cards: Array<Record<string, unknown>>) {
  let createdMessage: any = null;
  const prisma = {
    contacts: {
      findFirst: jest.fn().mockResolvedValue({ id: CONTACT_ID }),
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: CONTACT_ID, whatsapp_config: { id: 'instance-1' } }),
    },
    crm_user_instance_permissions: { findMany: jest.fn().mockResolvedValue([]) },
    crm_user_contact_permissions: {
      findMany: jest.fn().mockResolvedValue([{ contact_id: CONTACT_ID }]),
    },
    crm_user_funnel_permissions: { findMany: jest.fn().mockResolvedValue([]) },
    crm_cards: { findMany: jest.fn().mockResolvedValue(cards) },
    messages: {
      findFirst: jest.fn().mockResolvedValue(null),
      // processQueuedMessage roda em setImmediate() apos o create(); como
      // este teste nao cobre a entrega real via W-API, findUnique retorna
      // null para que processQueuedMessage retorne cedo (sem crashar o
      // processo com fetch() nao mockado).
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => {
        createdMessage = { id: 1n, ...data };
        return createdMessage;
      }),
    },
  };
  const realtime = { emit: jest.fn(), contact: jest.fn(), instance: jest.fn() };
  const service = new CrmService(prisma as never, {} as never, realtime as never, {} as never);
  return { service, getCreatedMessage: () => createdMessage };
}

describe('CrmService.send - autorização por card (Fase 3)', () => {
  it('bloqueia o vendedor antigo após a transferência (403)', async () => {
    const { service } = makeService([
      { id: 'card-1', kind: 'sales', status: 'active', assigned_user_id: JOAO.sub },
    ]);
    await expect(
      service.send(CONTACT_ID, { content: 'oi', context: 'sales' }, VICTOR),
    ).rejects.toThrow(/não é mais o responsável/);
  });

  it('permite o novo vendedor enviar após a transferência e audita sent_by_context/crm_card_id', async () => {
    const { service, getCreatedMessage } = makeService([
      { id: 'card-1', kind: 'sales', status: 'active', assigned_user_id: JOAO.sub },
    ]);
    await service.send(CONTACT_ID, { content: 'oi', context: 'sales' }, JOAO);
    expect(getCreatedMessage().sent_by_context).toBe('sales');
    expect(getCreatedMessage().crm_card_id).toBe('card-1');
    expect(getCreatedMessage().sent_by_user_id).toBe(JOAO.sub);
  });

  it('atendente de suporte consegue enviar sem ser o responsável comercial', async () => {
    const { service, getCreatedMessage } = makeService([
      { id: 'card-sales', kind: 'sales', status: 'active', assigned_user_id: JOAO.sub },
      { id: 'card-support', kind: 'support', status: 'active', assigned_user_id: MARIA.sub },
    ]);
    await service.send(CONTACT_ID, { content: 'como posso ajudar', context: 'support' }, MARIA);
    expect(getCreatedMessage().sent_by_context).toBe('support');
    expect(getCreatedMessage().crm_card_id).toBe('card-support');
  });

  it('admin sempre pode enviar, mesmo sem ser responsável de nenhum card', async () => {
    const { service, getCreatedMessage } = makeService([
      { id: 'card-1', kind: 'sales', status: 'active', assigned_user_id: JOAO.sub },
    ]);
    await service.send(CONTACT_ID, { content: 'oi', context: 'sales' }, ADMIN);
    expect(getCreatedMessage().sent_by_user_id).toBe(ADMIN.sub);
  });

  it('sem contexto explícito, sem card próprio, mas com card ativo de outro -> bloqueado', async () => {
    const { service } = makeService([
      { id: 'card-1', kind: 'sales', status: 'active', assigned_user_id: JOAO.sub },
    ]);
    await expect(service.send(CONTACT_ID, { content: 'oi' }, VICTOR)).rejects.toThrow(
      /já está atribuído a outro responsável/,
    );
  });

  it('sem contexto explícito e sem nenhum card existente -> permite (contato ainda não claimado)', async () => {
    const { service, getCreatedMessage } = makeService([]);
    await service.send(CONTACT_ID, { content: 'oi' }, VICTOR);
    expect(getCreatedMessage().sent_by_context).toBeNull();
    expect(getCreatedMessage().crm_card_id).toBeNull();
  });
});
