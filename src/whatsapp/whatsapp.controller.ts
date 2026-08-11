import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import {
  CreateWhatsappInstanceDto,
  UpdateWhatsappInstanceDto,
  UpdateWhatsappStatusDto,
} from './dto/whatsapp.dto';
import { WhatsappService } from './whatsapp.service';

type AuthRequest = Request & { user: { sub: string; role: string } };

@Controller('whatsapp')
export class WhatsappController {
  constructor(private readonly whatsapp: WhatsappService) {}

  @UseGuards(JwtAuthGuard)
  @Post('instances')
  create(@Req() request: AuthRequest, @Body() body: CreateWhatsappInstanceDto) {
    this.assertManager(request);
    return this.whatsapp.createInstance(body);
  }

  @UseGuards(JwtAuthGuard)
  @Get('instances')
  list(@Req() request: AuthRequest, @Query('sync') sync?: string) {
    return this.whatsapp.instances(sync === 'true', request.user);
  }

  @UseGuards(JwtAuthGuard)
  @Get('instances/:id')
  get(@Param('id') id: string) {
    return this.whatsapp.config(id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('instances/:id/credentials')
  credentials(@Req() request: AuthRequest, @Param('id') id: string) {
    this.assertManager(request);
    return this.whatsapp.credentials(id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('instances/:id')
  update(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateWhatsappInstanceDto,
  ) {
    this.assertManager(request);
    return this.whatsapp.updateInstance(id, body);
  }

  @UseGuards(JwtAuthGuard)
  @Get('instances/:id/qr-code')
  qrCode(@Param('id') id: string, @Query('image') image?: string) {
    return this.whatsapp.qrCode(id, image);
  }

  @UseGuards(JwtAuthGuard)
  @Get('instances/:id/pairing-code')
  pairingCode(
    @Param('id') id: string,
    @Query('phoneNumber') phoneNumber: string,
  ) {
    return this.whatsapp.pairingCode(id, phoneNumber);
  }

  @UseGuards(JwtAuthGuard)
  @Post('instances/:id/disconnect')
  disconnect(@Req() request: AuthRequest, @Param('id') id: string) {
    this.assertManager(request);
    return this.whatsapp.disconnect(id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('instances/:id/status-instance')
  providerStatus(@Param('id') id: string) {
    return this.whatsapp.providerStatus(id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('instances/:id/fetch-instance')
  fetchProviderInstance(@Param('id') id: string) {
    return this.whatsapp.fetchProviderInstance(id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('instances/:id/queue')
  queue(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('perPage') perPage?: string,
  ) {
    return this.whatsapp.queue(id, Number(page) || 1, Number(perPage) || 10);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('instances/:id/queue')
  deleteQueue(@Req() request: AuthRequest, @Param('id') id: string) {
    this.assertManager(request);
    return this.whatsapp.deleteQueue(id);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('instances/:id/queue/:insertedId')
  deleteQueueMessage(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Param('insertedId') insertedId: string,
  ) {
    this.assertManager(request);
    return this.whatsapp.deleteQueueMessage(id, insertedId);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('instances/:id/status')
  status(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateWhatsappStatusDto,
  ) {
    this.assertManager(request);
    return this.whatsapp.updateStatus(id, body.status);
  }

  @UseGuards(JwtAuthGuard)
  @Post('instances/:id/sync-group-names')
  syncGroupNames(@Req() request: AuthRequest, @Param('id') id: string) {
    this.assertManager(request);
    return this.whatsapp.syncGroupNames(id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('instances/:id/configure-webhooks')
  configureWebhooks(@Req() request: AuthRequest, @Param('id') id: string) {
    this.assertManager(request);
    return this.whatsapp.configureWebhooks(id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('messages/:id/recover-media')
  recoverMedia(@Param('id') id: string) {
    return this.whatsapp.recoverMedia(id);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('instances/:id')
  remove(@Req() request: AuthRequest, @Param('id') id: string) {
    this.assertManager(request);
    return this.whatsapp.deleteInstance(id);
  }

  @Post('webhook')
  webhook(@Body() body: unknown, @Query('secret') secret?: string) {
    return this.whatsapp.webhook(body, secret);
  }

  private assertManager(request: AuthRequest) {
    if (!['master', 'admin'].includes(request.user.role))
      throw new ForbiddenException('Sem permissão para gerenciar instâncias');
  }
}
