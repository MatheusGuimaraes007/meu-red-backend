/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unused-vars */
import {
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

type SessionContext = { userAgent?: string; ipAddress?: string };

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    const email = this.config.get<string>('MASTER_ADMIN_EMAIL')?.toLowerCase();
    const password = this.config.get<string>('MASTER_ADMIN_PASSWORD');
    if (!email || !password) return;
    const existing = await this.prisma.crm_users.findUnique({
      where: { email },
    });
    if (!existing) {
      await this.prisma.crm_users.create({
        data: {
          name: 'Master Admin',
          email,
          password_hash: await hash(password, 12),
          role: 'master',
        },
      });
    }
  }

  async login(email: string, password: string, context: SessionContext = {}) {
    const user = await this.prisma.crm_users.findFirst({
      where: { email: email.toLowerCase(), status: 'active' },
    });
    if (!user || !(await compare(password, user.password_hash)))
      throw new UnauthorizedException('Credenciais inválidas');
    return this.createSession(user, context);
  }

  async refresh(refreshToken: string, context: SessionContext = {}) {
    const current = await this.prisma.crm_refresh_tokens.findUnique({
      where: { token_hash: this.hashToken(refreshToken) },
      include: { crm_users: true },
    });
    if (
      !current ||
      current.revoked_at ||
      current.expires_at <= new Date() ||
      current.crm_users.status !== 'active'
    ) {
      throw new UnauthorizedException('Refresh token inválido ou expirado');
    }

    const nextToken = this.generateRefreshToken();
    const next = await this.prisma.$transaction(async (tx) => {
      const created = await tx.crm_refresh_tokens.create({
        data: {
          user_id: current.user_id,
          token_hash: this.hashToken(nextToken),
          expires_at: this.refreshExpiry(),
          user_agent: context.userAgent,
          ip_address: context.ipAddress,
        },
      });
      await tx.crm_refresh_tokens.update({
        where: { id: current.id },
        data: {
          revoked_at: new Date(),
          replaced_by_token_id: created.id,
          updated_at: new Date(),
        },
      });
      return created;
    });

    return {
      access_token: await this.signAccessToken(current.crm_users),
      refresh_token: nextToken,
      refresh_token_expires_at: next.expires_at,
      user: this.safe(current.crm_users),
    };
  }

  async logout(refreshToken: string) {
    await this.prisma.crm_refresh_tokens.updateMany({
      where: { token_hash: this.hashToken(refreshToken), revoked_at: null },
      data: { revoked_at: new Date(), updated_at: new Date() },
    });
    return { ok: true };
  }

  async logoutAll(userId: string) {
    await this.prisma.crm_refresh_tokens.updateMany({
      where: { user_id: userId, revoked_at: null },
      data: { revoked_at: new Date(), updated_at: new Date() },
    });
    return { ok: true };
  }

  async me(id: string) {
    return this.safe(await this.prisma.crm_users.findUnique({ where: { id } }));
  }

  private async createSession(user: any, context: SessionContext) {
    const refreshToken = this.generateRefreshToken();
    const record = await this.prisma.crm_refresh_tokens.create({
      data: {
        user_id: user.id,
        token_hash: this.hashToken(refreshToken),
        expires_at: this.refreshExpiry(),
        user_agent: context.userAgent,
        ip_address: context.ipAddress,
      },
    });
    return {
      access_token: await this.signAccessToken(user),
      refresh_token: refreshToken,
      refresh_token_expires_at: record.expires_at,
      user: this.safe(user),
    };
  }

  private signAccessToken(user: { id: string; email: string; role: string }) {
    return this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role,
    });
  }

  private generateRefreshToken() {
    return randomBytes(48).toString('base64url');
  }
  private hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }
  private refreshExpiry() {
    const days = Math.max(
      1,
      Number(this.config.get('REFRESH_TOKEN_EXPIRES_IN_DAYS', 30)) || 30,
    );
    return new Date(Date.now() + days * 86_400_000);
  }
  private safe<T extends { password_hash: string }>(user: T | null) {
    if (!user) return null;
    const { password_hash: _, ...safe } = user;
    return safe;
  }
}
