/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { CrmService } from '../crm/crm.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from './realtime.service';

type SocketUser = { sub: string; role: string; email: string };
type AuthenticatedSocket = Socket & { data: { user?: SocketUser } };

@WebSocketGateway({
  namespace: '/chat',
  cors: { origin: true, credentials: true },
})
export class ChatGateway implements OnGatewayInit, OnGatewayConnection {
  @WebSocketServer() private readonly server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly crm: CrmService,
    private readonly realtime: RealtimeService,
  ) {}

  afterInit(server: Server) {
    this.realtime.bind(server);
  }

  async handleConnection(client: AuthenticatedSocket) {
    try {
      const header = client.handshake.headers.authorization;
      const token = String(
        client.handshake.auth?.token ||
          header?.replace(/^Bearer\s+/i, '') ||
          '',
      );
      if (!token) throw new UnauthorizedException();
      const user = await this.jwt.verifyAsync<SocketUser>(token);
      client.data.user = user;
      await client.join(`user:${user.sub}`);
      client.emit('chat.connected', { ok: true });
    } catch {
      client.emit('exception', { message: 'Token inválido ou ausente' });
      client.disconnect(true);
    }
  }

  @SubscribeMessage('chat:join')
  async join(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    body: {
      instanceId?: string;
      contactId?: string;
      conversationId?: string;
      requestId?: string;
    },
  ) {
    const instanceId = await this.resolveAndAuthorize(client, body);
    const rooms = [
      `instance:${instanceId}`,
      body.contactId && `contact:${body.contactId}`,
      body.conversationId && `conversation:${body.conversationId}`,
    ].filter(Boolean) as string[];
    await client.join(rooms);
    return { ok: true, requestId: body.requestId, rooms };
  }

  @SubscribeMessage('chat:leave')
  async leave(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody()
    body: {
      instanceId?: string;
      contactId?: string;
      conversationId?: string;
      requestId?: string;
    },
  ) {
    const rooms = [
      body.instanceId && `instance:${body.instanceId}`,
      body.contactId && `contact:${body.contactId}`,
      body.conversationId && `conversation:${body.conversationId}`,
    ].filter(Boolean) as string[];
    for (const room of rooms) await client.leave(room);
    return { ok: true, requestId: body.requestId };
  }

  @SubscribeMessage('message:send')
  async send(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: Record<string, any>,
  ) {
    if (!body.contactId)
      throw new ForbiddenException('contactId é obrigatório');
    const instanceId = await this.resolveAndAuthorize(client, {
      contactId: body.contactId,
    });
    const message = await this.crm.send(body.contactId, body, client.data.user);
    void instanceId;
    return {
      ok: true,
      requestId: body.requestId,
      messageId: String(message.id),
    };
  }

  @SubscribeMessage('message:edit')
  edit(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: Record<string, any>,
  ) {
    return this.action(client, body, 'edit');
  }

  @SubscribeMessage('message:delete')
  remove(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: Record<string, any>,
  ) {
    return this.action(client, body, 'delete');
  }

  @SubscribeMessage('message:retry')
  retry(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: Record<string, any>,
  ) {
    return this.retryMessage(client, body);
  }

  @SubscribeMessage('conversation:read')
  async markRead(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: Record<string, any>,
  ) {
    if (!body.contactId)
      throw new ForbiddenException('contactId é obrigatório');
    await this.resolveAndAuthorize(client, { contactId: body.contactId });
    await this.crm.markConversationRead(body.contactId, client.data.user);
    return { ok: true, requestId: body.requestId, contactId: body.contactId };
  }

  private async action(
    client: AuthenticatedSocket,
    body: Record<string, any>,
    action: 'edit' | 'delete',
  ) {
    if (!body.messageId)
      throw new ForbiddenException('messageId é obrigatório');
    const existing = await this.prisma.messages.findUnique({
      where: { id: BigInt(body.messageId) },
      select: { contact_id: true },
    });
    if (!existing) throw new ForbiddenException('Mensagem inválida');
    await this.resolveAndAuthorize(client, { contactId: existing.contact_id });
    const message = await this.crm.messageAction(
      String(body.messageId),
      { ...body, action },
      client.data.user?.sub,
    );
    const event =
      action === 'delete' ? 'message:deleted_on_whatsapp' : 'message:updated';
    void event;
    return {
      ok: true,
      requestId: body.requestId,
      messageId: String(message.id),
    };
  }

  private async retryMessage(
    client: AuthenticatedSocket,
    body: Record<string, any>,
  ) {
    if (!body.messageId)
      throw new ForbiddenException('messageId é obrigatório');
    const message = await this.prisma.messages.findUnique({
      where: { id: BigInt(body.messageId) },
      select: { contact_id: true },
    });
    if (!message) throw new ForbiddenException('Mensagem inválida');
    await this.resolveAndAuthorize(client, { contactId: message.contact_id });
    const retried = await this.crm.retry(String(body.messageId));
    return {
      ok: true,
      requestId: body.requestId,
      messageId: String(retried.id),
    };
  }

  private async resolveAndAuthorize(
    client: AuthenticatedSocket,
    body: { instanceId?: string; contactId?: string },
  ) {
    const user = client.data.user;
    if (!user) throw new UnauthorizedException();
    const contact = body.contactId
      ? await this.prisma.contacts.findUnique({
          where: { id: body.contactId },
          select: { whatsapp_config_id: true, crm_funnel_id: true },
        })
      : null;
    const instanceId = body.instanceId || contact?.whatsapp_config_id;
    if (!instanceId) throw new ForbiddenException('Instância inválida');
    if (user.role === 'master' || user.role === 'admin') return instanceId;
    const [instanceAccess, contactAccess, funnelAccess] = await Promise.all([
      this.prisma.crm_user_instance_permissions.findFirst({
        where: { user_id: user.sub, whatsapp_config_id: instanceId },
      }),
      body.contactId
        ? this.prisma.crm_user_contact_permissions.findFirst({
            where: { user_id: user.sub, contact_id: body.contactId },
          })
        : Promise.resolve(null),
      contact?.crm_funnel_id
        ? this.prisma.crm_user_funnel_permissions.findFirst({
            where: { user_id: user.sub, funnel_id: contact.crm_funnel_id },
          })
        : Promise.resolve(null),
    ]);
    if (!instanceAccess && !contactAccess && !funnelAccess)
      throw new ForbiddenException('Sem acesso à conversa');
    return instanceId;
  }

  private serialize(value: unknown): unknown {
    if (typeof value === 'bigint') return value.toString();
    if (Array.isArray(value)) return value.map((item) => this.serialize(item));
    if (value instanceof Date || value === null || typeof value !== 'object')
      return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, this.serialize(item)]),
    );
  }
}
