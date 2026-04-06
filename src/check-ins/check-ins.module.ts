import { Module } from '@nestjs/common';
import { CheckInsController } from './check-ins.controller';
import { CheckInsService } from './check-ins.service';

@Module({
  controllers: [CheckInsController],
  providers: [CheckInsService],
})
export class CheckInsModule { }
