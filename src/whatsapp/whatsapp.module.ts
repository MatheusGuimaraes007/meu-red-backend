import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeEventsModule } from '../realtime/realtime-events.module';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
@Module({
  imports: [AuthModule, RealtimeEventsModule],
  controllers: [WhatsappController],
  providers: [WhatsappService],
})
export class WhatsappModule {}
