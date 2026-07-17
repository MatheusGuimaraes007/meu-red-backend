import { Global, Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaStorageService } from './media-storage.service';

@Global()
@Module({
  controllers: [MediaController],
  providers: [MediaStorageService],
  exports: [MediaStorageService],
})
export class MediaModule {}
