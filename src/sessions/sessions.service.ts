import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSessionDto } from './dto/create-session.dto';

@Injectable()
export class SessionsService {
  constructor(private prisma: PrismaService) { }

  async create(userId: string, dto: CreateSessionDto) {
    return this.prisma.session.create({
      data: {
        userId,
        protocolId: dto.protocolId,
        protocolName: dto.protocolName,
        category: dto.category,
        durationSeconds: dto.durationSeconds,
        targetDurationSeconds: dto.targetDurationSeconds,
        completed: dto.completed,
        sessionDate: new Date(dto.sessionDate),
      },
    });
  }

  async findAll(userId: string, limit = 50) {
    return this.prisma.session.findMany({
      where: { userId },
      orderBy: { sessionDate: 'desc' },
      take: limit,
    });
  }

  async getStats(userId: string) {
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    const sessions = await this.prisma.session.findMany({
      where: { userId },
      orderBy: { sessionDate: 'desc' },
    });

    const weeklySessions = sessions.filter(
      (s) => new Date(s.sessionDate) >= startOfWeek && s.completed,
    );

    const weeklyMinutes = weeklySessions.reduce(
      (sum, s) => sum + Math.round(s.durationSeconds / 60),
      0,
    );

    // Streak calculation
    let streak = 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const uniqueDates = [
      ...new Set(
        sessions
          .filter((s) => s.completed)
          .map((s) => new Date(s.sessionDate).toISOString().split('T')[0]),
      ),
    ].sort((a, b) => b.localeCompare(a));

    for (let i = 0; i < uniqueDates.length; i++) {
      const expected = new Date(today);
      expected.setDate(today.getDate() - i);
      const expectedStr = expected.toISOString().split('T')[0];
      if (uniqueDates[i] === expectedStr) {
        streak++;
      } else {
        break;
      }
    }

    // Best week
    const weekMap = new Map<string, number>();
    for (const s of sessions.filter((s) => s.completed)) {
      const d = new Date(s.sessionDate);
      const weekStart = new Date(d);
      weekStart.setDate(d.getDate() - d.getDay());
      const key = weekStart.toISOString().split('T')[0];
      weekMap.set(key, (weekMap.get(key) || 0) + 1);
    }
    const bestWeek = Math.max(0, ...weekMap.values());

    return {
      totalSessions: sessions.filter((s) => s.completed).length,
      totalMinutes: sessions
        .filter((s) => s.completed)
        .reduce((sum, s) => sum + Math.round(s.durationSeconds / 60), 0),
      weeklyMinutes,
      weeklySessionCount: weeklySessions.length,
      streak,
      bestWeek,
    };
  }
}
