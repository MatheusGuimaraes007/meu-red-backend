import { Module } from '@nestjs/common'; import { AuthModule } from '../auth/auth.module'; import { CrmController } from './crm.controller'; import { CrmService } from './crm.service';
@Module({imports:[AuthModule],controllers:[CrmController],providers:[CrmService],exports:[CrmService]}) export class CrmModule{}
