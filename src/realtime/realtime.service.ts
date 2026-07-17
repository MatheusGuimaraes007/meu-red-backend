/* eslint-disable @typescript-eslint/no-unsafe-return */
import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';

@Injectable()
export class RealtimeService {
  private server?: Server;

  bind(server: Server) {
    this.server = server;
  }

  emit(event: string, payload: Record<string, unknown>, rooms: string[]) {
    if (!this.server || rooms.length === 0) return;
    const serialized = this.serialize(payload);
    this.server.to(rooms).emit(event, serialized);
    const alias = this.eventAlias(event);
    if (alias) this.server.to(rooms).emit(alias, serialized);
  }

  user(id: string) {
    return `user:${id}`;
  }
  instance(id: string) {
    return `instance:${id}`;
  }
  contact(id: string) {
    return `contact:${id}`;
  }
  conversation(id: string) {
    return `conversation:${id}`;
  }

  private eventAlias(event: string) {
    const aliases: Record<string, string> = {
      'message:created': 'message.created',
      'message:updated': 'message.updated',
      'message:status': 'message.updated',
      'message:failed': 'message.updated',
      'conversation:created': 'conversation.updated',
      'conversation:updated': 'conversation.updated',
      'instance:status': 'instance.status_changed',
    };
    return aliases[event];
  }

  private serialize(value: unknown): any {
    if (typeof value === 'bigint') return value.toString();
    if (Array.isArray(value)) return value.map((item) => this.serialize(item));
    if (value instanceof Date) return value.toISOString();
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, this.serialize(item)]),
    );
  }
}
