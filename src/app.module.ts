import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { CrmModule } from './crm/crm.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { RealtimeModule } from './realtime/realtime.module';
import { HealthModule } from './health/health.module';
import { MediaModule } from './media/media.module';
import { IntegrationsModule } from './integrations/integrations.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    CrmModule,
    WhatsappModule,
    RealtimeModule,
    HealthModule,
    MediaModule,
    IntegrationsModule,
  ],
})
export class AppModule {}
