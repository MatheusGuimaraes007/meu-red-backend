import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CrmModule } from '../crm/crm.module';
import { ChatGateway } from './chat.gateway';
import { RealtimeEventsModule } from './realtime-events.module';

@Module({
  imports: [AuthModule, CrmModule, RealtimeEventsModule],
  providers: [ChatGateway],
})
export class RealtimeModule {}
