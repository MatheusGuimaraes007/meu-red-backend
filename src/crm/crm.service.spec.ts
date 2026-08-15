import { CrmService } from './crm.service';

type ClientMessageSerializer = {
  messageForClient(
    message: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
};

describe('CrmService contact names', () => {
  it('marks a manually edited contact name in metadata', async () => {
    const existing = {
      id: 'contact-id',
      name: '123@g.us',
      metadata: { isGroup: true, chatId: '123@g.us' },
    };
    const update = jest.fn().mockResolvedValue({
      ...existing,
      name: 'Grupo editado',
    });
    const prisma = {
      contacts: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(existing)
          .mockResolvedValueOnce({
            ...existing,
            name: 'Grupo editado',
            crm_contact_tags: [],
          }),
        update,
      },
    };
    const realtime = {
      emit: jest.fn(),
      contact: jest.fn(),
      instance: jest.fn(),
    };
    const service = new CrmService(
      prisma as never,
      {} as never,
      realtime as never,
      {} as never,
    );

    await service.updateContact('contact-id', { name: 'Grupo editado' });

    expect(update).toHaveBeenCalledWith({
      where: { id: 'contact-id' },
      data: {
        name: 'Grupo editado',
        metadata: {
          isGroup: true,
          chatId: '123@g.us',
          name_source: 'manual',
        },
      },
    });
  });

  it('exposes persisted reply context as reply_to', async () => {
    const service = new CrmService(
      {} as never,
      {} as never,
      {} as never,
      { signedUrl: jest.fn().mockResolvedValue(null) } as never,
    );
    const serializer = service as unknown as ClientMessageSerializer;

    const result = await serializer.messageForClient({
      id: 2n,
      metadata: {
        reply_to: {
          message_id: '1',
          external_message_id: 'QUOTED-ID',
          content: 'mensagem original',
          message_type: 'text',
          role: 'user',
          sender_name: 'Matheus',
        },
      },
      media_storage_bucket: null,
      media_storage_path: null,
    });

    expect(result.reply_to).toEqual({
      message_id: '1',
      external_message_id: 'QUOTED-ID',
      content: 'mensagem original',
      message_type: 'text',
      role: 'user',
      sender_name: 'Matheus',
    });
  });
});

describe('CrmService board totals', () => {
  it('returns all 402 contacts from database aggregates independently of card pagination', async () => {
    const prisma = {
      whatsapp_config: { findFirst: jest.fn().mockResolvedValue({ id: 'instance-1' }) },
      crm_funnels: { findFirst: jest.fn().mockResolvedValue({ id: 'funnel-1', whatsapp_config_id: 'instance-1' }) },
      contacts: {
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([
          { crm_stage_id: 'stage-1', _count: { id: 97 } },
          { crm_stage_id: 'stage-2', _count: { id: 150 } },
          { crm_stage_id: 'stage-3', _count: { id: 154 } },
          { crm_stage_id: null, _count: { id: 1 } },
        ]),
        count: jest.fn().mockResolvedValueOnce(402).mockResolvedValueOnce(1).mockResolvedValueOnce(3),
      },
      $transaction: jest.fn((operations: Array<Promise<unknown>>) => Promise.all(operations)),
    };
    const service = new CrmService(prisma as never, {} as never, {} as never, {} as never);

    const result = await service.boardSummary('funnel-1', 'instance-1');

    expect(result.total).toBe(402);
    expect(Object.values(result.stages).reduce((sum, count) => sum + count, 0)).toBe(401);
    expect(result.withoutStage).toBe(1);
    expect(result.withoutFunnel).toBe(3);
    expect(prisma.contacts.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      by: ['crm_stage_id'],
      where: expect.objectContaining({ whatsapp_config_id: 'instance-1', crm_funnel_id: 'funnel-1' }),
    }));
  });
});
