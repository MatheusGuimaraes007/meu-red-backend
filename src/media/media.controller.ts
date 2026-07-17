import {
  Controller,
  Get,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PrismaService } from '../prisma/prisma.service';
import { MediaStorageService } from './media-storage.service';

@UseGuards(JwtAuthGuard)
@Controller('uploads')
export class MediaController {
  constructor(
    private readonly media: MediaStorageService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 52_428_800, files: 1 },
    }),
  )
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Req() request: Request & { user: { sub: string } },
  ) {
    return this.media.upload(file, request.user.sub);
  }

  @Get('messages/:id/url')
  async messageUrl(@Param('id') id: string) {
    const message = await this.prisma.messages.findUnique({
      where: { id: BigInt(id) },
      select: { media_storage_bucket: true, media_storage_path: true },
    });
    return {
      url: await this.media.signedUrl(
        message?.media_storage_bucket,
        message?.media_storage_path,
      ),
    };
  }
}
