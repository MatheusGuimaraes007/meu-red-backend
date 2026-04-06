import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEngagementDto } from './dto/create-engagement.dto';

@Injectable()
export class EngagementService {
  constructor(private prisma: PrismaService) { }

  async create(userId: string, dto: CreateEngagementDto) {
    return this.prisma.engagementEvent.create({
      data: {
        userId,
        eventType: dto.eventType,
        feedbackReason: dto.feedbackReason,
        sessionCount: dto.sessionCount,
      },
    });
  }

  async getNextAction(userId: string) {
    // Count total completed sessions
    const totalSessions = await this.prisma.session.count({
      where: { userId, completed: true },
    });

    // Get latest engagement events
    const lastFeedback = await this.prisma.engagementEvent.findFirst({
      where: {
        userId,
        eventType: { in: ['feedback_positive', 'feedback_negative'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    const lastUgc = await this.prisma.engagementEvent.findFirst({
      where: {
        userId,
        eventType: { in: ['ugc_shared', 'ugc_declined'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    const lastReview = await this.prisma.engagementEvent.findFirst({
      where: {
        userId,
        eventType: { in: ['review_completed', 'review_declined'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Feedback: every 2-3 sessions since last feedback
    const lastFeedbackSessionCount = lastFeedback?.sessionCount ?? 0;
    const sessionsSinceLastFeedback = totalSessions - lastFeedbackSessionCount;

    if (sessionsSinceLastFeedback >= 2) {
      return { action: 'feedback' };
    }

    // UGC: after positive feedback, every 5 sessions
    if (lastFeedback?.eventType === 'feedback_positive') {
      const lastUgcSessionCount = lastUgc?.sessionCount ?? 0;
      const sessionsSinceLastUgc = totalSessions - lastUgcSessionCount;

      // Count UGC declines
      const ugcDeclines = await this.prisma.engagementEvent.count({
        where: { userId, eventType: 'ugc_declined' },
      });

      if (sessionsSinceLastUgc >= 5 && ugcDeclines < 3) {
        return { action: 'ugc' };
      }
    }

    // Review: after 10+ sessions, with 10-day cooldown
    if (totalSessions >= 10) {
      const tenDaysAgo = new Date();
      tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);

      if (!lastReview || new Date(lastReview.createdAt) < tenDaysAgo) {
        return { action: 'review' };
      }
    }

    return { action: null };
  }
}
