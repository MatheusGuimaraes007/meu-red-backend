import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CrmController } from './crm.controller';
import { CrmService } from './crm.service';
import { CrmCardsController } from './crm-cards.controller';
import { CrmCardsService } from './crm-cards.service';
@Module({
  imports: [AuthModule],
  controllers: [CrmController, CrmCardsController],
  providers: [CrmService, CrmCardsService],
  exports: [CrmService, CrmCardsService],
})
export class CrmModule {}
