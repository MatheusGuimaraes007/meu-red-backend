import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { ProfileModule } from './profile/profile.module';
import { SessionsModule } from './sessions/sessions.module';
import { CheckInsModule } from './check-ins/check-ins.module';
import { EngagementModule } from './engagement/engagement.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    ProfileModule,
    SessionsModule,
    CheckInsModule,
    EngagementModule,
  ],
})
export class AppModule { }
