import { ConflictException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CrmCardsService } from './crm-cards.service';

const INSTANCE_ID = 'instance-1';
const CONTACT_ID = 'contact-1';
const VICTOR = { sub: 'user-victor', role: 'agent' };
const JOAO = { sub: 'user-joao', role: 'agent' };
const ADMIN = { sub: 'user-admin', role: 'admin' };
const MARIA = { sub: 'user-maria', role: 'agent' };

type FakeCard = {
  id: string;
  contact_id: string;
  kind: 'sales' | 'support';
  funnel_id: string;
  stage_id: string;
  assigned_user_id: string | null;
  status: 'active' | 'closed';
  source: string;
  stage_entered_at: Date;
  assigned_at: Date | null;
  closed_at: Date | null;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
};

function makeFakeDb() {
  const cardsDb: FakeCard[] = [];
  const movementsDb: any[] = [];
  const funnelsDb = [
    { id: 'funnel-victor', kind: 'sales', owner_user_id: VICTOR.sub },
    { id: 'funnel-joao', kind: 'sales', owner_user_id: JOAO.sub },
    { id: 'funnel-support', kind: 'support', owner_user_id: null },
  ];
  const stagesDb = [
    { id: 'stage-victor-1', funnel_id: 'funnel-victor' },
    { id: 'stage-victor-2', funnel_id: 'funnel-victor' },
    { id: 'stage-joao-1', funnel_id: 'funnel-joao' },
    { id: 'stage-support-1', funnel_id: 'funnel-support' },
  ];
  const usersDb = [
    { id: VICTOR.sub, name: 'Victor' },
    { id: JOAO.sub, name: 'Joao' },
    { id: MARIA.sub, name: 'Maria' },
  ];

  let cardSeq = 0;
  const prisma = {
    contacts: {
      findFirst: jest.fn().mockResolvedValue({
        id: CONTACT_ID,
        whatsapp_config_id: INSTANCE_ID,
        name: 'Cliente Teste',
      }),
    },
    crm_funnels: {
      findUnique: jest.fn(async ({ where }: any) =>
        funnelsDb.find((f) => f.id === where.id) ?? null,
      ),
    },
    crm_stages: {
      findFirst: jest.fn(async ({ where }: any) =>
        stagesDb.find((s) => s.id === where.id && s.funnel_id === where.funnel_id) ?? null,
      ),
    },
    crm_users: {
      findUnique: jest.fn(async ({ where }: any) =>
        usersDb.find((u) => u.id === where.id) ?? null,
      ),
    },
    crm_cards: {
      findFirst: jest.fn(async ({ where }: any) =>
        cardsDb.find(
          (c) =>
            c.contact_id === where.contact_id &&
            c.kind === where.kind &&
            c.status === where.status,
        ) ?? null,
      ),
      findUnique: jest.fn(async ({ where }: any) =>
        cardsDb.find((c) => c.id === where.id) ?? null,
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const card = cardsDb.find(
          (c) => c.id === where.id && c.assigned_user_id === where.assigned_user_id,
        );
        if (!card) return { count: 0 };
        Object.assign(card, data);
        return { count: 1 };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const card = cardsDb.find((c) => c.id === where.id);
        if (!card) throw new Error('not found');
        Object.assign(card, data);
        return card;
      }),
      create: jest.fn(async ({ data }: any) => {
        const conflict = cardsDb.find(
          (c) => c.contact_id === data.contact_id && c.kind === data.kind && c.status === 'active',
        );
        if (conflict) {
          throw new Prisma.PrismaClientKnownRequestError(
            'Unique constraint failed',
            { code: 'P2002', clientVersion: '6.19.3' },
          );
        }
        cardSeq += 1;
        const created: FakeCard = {
          id: `card-${cardSeq}`,
          status: 'active',
          metadata: {},
          created_at: new Date(),
          updated_at: new Date(),
          assigned_at: data.assigned_user_id ? new Date() : null,
          closed_at: null,
          stage_entered_at: new Date(),
          source: data.source,
          contact_id: data.contact_id,
          kind: data.kind,
          funnel_id: data.funnel_id,
          stage_id: data.stage_id,
          assigned_user_id: data.assigned_user_id ?? null,
        };
        cardsDb.push(created);
        return created;
      }),
    },
    crm_card_movements: {
      create: jest.fn(async ({ data }: any) => {
        movementsDb.push(data);
        return data;
      }),
      findMany: jest.fn(async () => movementsDb),
    },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  return { prisma, cardsDb, movementsDb, funnelsDb, stagesDb };
}

function makeRealtime() {
  return {
    emit: jest.fn(),
    instance: (id: string) => `instance:${id}`,
    contact: (id: string) => `contact:${id}`,
    user: (id: string) => `user:${id}`,
  };
}

function makeCrmStub() {
  return { contact: jest.fn().mockResolvedValue({ id: CONTACT_ID }) };
}

describe('CrmCardsService', () => {
  it('cenario 1: contato sem card comercial -> Victor assume -> sales card criado no pipeline do Victor', async () => {
    const { prisma, cardsDb } = makeFakeDb();
    const service = new CrmCardsService(prisma as never, makeRealtime() as never, makeCrmStub() as never);

    const card: any = await service.claimSalesCard(
      CONTACT_ID,
      { funnel_id: 'funnel-victor', stage_id: 'stage-victor-1' },
      VICTOR,
    );

    expect(card.assigned_user_id).toBe(VICTOR.sub);
    expect(card.funnel_id).toBe('funnel-victor');
    expect(cardsDb).toHaveLength(1);
  });

  it('cenario 2: dois usuarios competem pelo mesmo card sem responsavel -> so um vence (409 para o outro)', async () => {
    const { prisma } = makeFakeDb();
    const service = new CrmCardsService(prisma as never, makeRealtime() as never, makeCrmStub() as never);

    // Suporte aberto sem responsavel primeiro (ex.: automacao).
    await service.openSupportCard(CONTACT_ID, { funnel_id: 'funnel-support', stage_id: 'stage-support-1' }, ADMIN);

    const results = await Promise.allSettled([
      service.openSupportCard(
        CONTACT_ID,
        { funnel_id: 'funnel-support', stage_id: 'stage-support-1', assigned_user_id: VICTOR.sub },
        ADMIN,
      ),
      service.openSupportCard(
        CONTACT_ID,
        { funnel_id: 'funnel-support', stage_id: 'stage-support-1', assigned_user_id: JOAO.sub },
        ADMIN,
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
  });

  it('cenario 3: admin atribui a Joao usando o pipeline do Joao -> ok', async () => {
    const { prisma } = makeFakeDb();
    const service = new CrmCardsService(prisma as never, makeRealtime() as never, makeCrmStub() as never);

    const card: any = await service.assignSalesCard(
      CONTACT_ID,
      { assigned_user_id: JOAO.sub, funnel_id: 'funnel-joao', stage_id: 'stage-joao-1' },
      ADMIN,
    );

    expect(card.assigned_user_id).toBe(JOAO.sub);
    expect(card.funnel_id).toBe('funnel-joao');
  });

  it('cenario 4: tentar atribuir Victor usando o pipeline do Joao -> rejeitado', async () => {
    const { prisma } = makeFakeDb();
    const service = new CrmCardsService(prisma as never, makeRealtime() as never, makeCrmStub() as never);

    await expect(
      service.assignSalesCard(
        CONTACT_ID,
        { assigned_user_id: VICTOR.sub, funnel_id: 'funnel-joao', stage_id: 'stage-joao-1' },
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('vendedor comum nao pode atribuir a outro vendedor (apenas para si mesmo)', async () => {
    const { prisma } = makeFakeDb();
    const service = new CrmCardsService(prisma as never, makeRealtime() as never, makeCrmStub() as never);

    await expect(
      service.assignSalesCard(
        CONTACT_ID,
        { assigned_user_id: JOAO.sub, funnel_id: 'funnel-joao', stage_id: 'stage-joao-1' },
        VICTOR,
      ),
    ).rejects.toThrow(/admin, master ou gestor/);
  });

  it('cenario 5: transferir Victor -> Joao mantem o mesmo card.id', async () => {
    const { prisma } = makeFakeDb();
    const service = new CrmCardsService(prisma as never, makeRealtime() as never, makeCrmStub() as never);

    const created: any = await service.claimSalesCard(
      CONTACT_ID,
      { funnel_id: 'funnel-victor', stage_id: 'stage-victor-1' },
      VICTOR,
    );

    const transferred: any = await service.transferCard(
      created.id,
      { assigned_user_id: JOAO.sub, funnel_id: 'funnel-joao', stage_id: 'stage-joao-1', reason: 'Redistribuicao' },
      ADMIN,
    );

    expect(transferred.id).toBe(created.id);
    expect(transferred.assigned_user_id).toBe(JOAO.sub);
    expect(transferred.funnel_id).toBe('funnel-joao');
  });

  it('cenario 9-11: sales card e support card coexistem e sao independentes', async () => {
    const { prisma, cardsDb } = makeFakeDb();
    const service = new CrmCardsService(prisma as never, makeRealtime() as never, makeCrmStub() as never);

    const sales: any = await service.claimSalesCard(
      CONTACT_ID,
      { funnel_id: 'funnel-victor', stage_id: 'stage-victor-1' },
      VICTOR,
    );
    const support: any = await service.openSupportCard(
      CONTACT_ID,
      { funnel_id: 'funnel-support', stage_id: 'stage-support-1', assigned_user_id: MARIA.sub },
      ADMIN,
    );

    expect(cardsDb).toHaveLength(2);
    expect(sales.id).not.toBe(support.id);

    // Mover a etapa do support nao deve tocar o sales.
    await service.moveCardStage(support.id, { stage_id: 'stage-support-1' }, MARIA);
    const salesAfter = cardsDb.find((c) => c.id === sales.id)!;
    expect(salesAfter.stage_id).toBe('stage-victor-1');
    expect(salesAfter.assigned_user_id).toBe(VICTOR.sub);

    // Transferir o sales nao deve tocar o support.
    await service.transferCard(
      sales.id,
      { assigned_user_id: JOAO.sub, funnel_id: 'funnel-joao', stage_id: 'stage-joao-1' },
      ADMIN,
    );
    const supportAfter = cardsDb.find((c) => c.id === support.id)!;
    expect(supportAfter.assigned_user_id).toBe(MARIA.sub);
    expect(supportAfter.funnel_id).toBe('funnel-support');
  });
});
