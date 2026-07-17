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
