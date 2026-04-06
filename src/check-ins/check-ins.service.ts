import { Injectable, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCheckInDto } from './dto/create-check-in.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class CheckInsService {
  constructor(private prisma: PrismaService) { }

  async create(userId: string, dto: CreateCheckInDto) {
    try {
      return await this.prisma.checkIn.create({
        data: {
          userId,
          pain: dto.pain,
          energy: dto.energy,
          sleep: dto.sleep,
          recovery: dto.recovery,
          checkInDate: new Date(dto.date),
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Já existe um check-in para este dia');
      }
      throw error;
    }
  }

  async findAll(userId: string, limit = 14) {
    return this.prisma.checkIn.findMany({
      where: { userId },
      orderBy: { checkInDate: 'desc' },
      take: limit,
    });
  }

  async getTrends(userId: string) {
    const checkIns = await this.prisma.checkIn.findMany({
      where: { userId },
      orderBy: { checkInDate: 'desc' },
      take: 30,
    });

    if (checkIns.length < 2) {
      return {
        pain: 'estável',
        energy: 'estável',
        sleep: 'estável',
        recovery: 'estável',
      };
    }

    const now = new Date();
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(now.getDate() - 7);
    const fourteenDaysAgo = new Date(now);
    fourteenDaysAgo.setDate(now.getDate() - 14);

    const recent = checkIns.filter(
      (c) => new Date(c.checkInDate) >= sevenDaysAgo,
    );
    const previous = checkIns.filter(
      (c) =>
        new Date(c.checkInDate) >= fourteenDaysAgo &&
        new Date(c.checkInDate) < sevenDaysAgo,
    );

    const calcTrend = (field: 'pain' | 'energy' | 'sleep' | 'recovery') => {
      if (recent.length === 0 || previous.length === 0) return 'estável';
      const avgRecent =
        recent.reduce((sum, c) => sum + c[field], 0) / recent.length;
      const avgPrevious =
        previous.reduce((sum, c) => sum + c[field], 0) / previous.length;
      const diff = avgRecent - avgPrevious;

      // For pain, lower is better (inverted)
      if (field === 'pain') {
        if (diff < -0.5) return 'melhorando';
        if (diff > 0.5) return 'caindo';
        return 'estável';
      }

      if (diff > 0.5) return 'melhorando';
      if (diff < -0.5) return 'caindo';
      return 'estável';
    };

    return {
      pain: calcTrend('pain'),
      energy: calcTrend('energy'),
      sleep: calcTrend('sleep'),
      recovery: calcTrend('recovery'),
    };
  }
}
