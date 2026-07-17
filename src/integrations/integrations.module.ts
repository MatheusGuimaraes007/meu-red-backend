import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IntegrationsController, PublicIntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';

@Module({
  imports: [AuthModule],
  controllers: [IntegrationsController, PublicIntegrationsController],
  providers: [IntegrationsService],
})
export class IntegrationsModule {}
