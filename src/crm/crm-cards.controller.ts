import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CrmCardsService } from './crm-cards.service';

type AuthedRequest = Request & { user: { sub: string; role: string } };

@UseGuards(JwtAuthGuard)
@Controller()
export class CrmCardsController {
  constructor(private readonly cards: CrmCardsService) {}

  @Get('contacts/:id/cards') listContactCards(
    @Req() request: AuthedRequest,
    @Param('id') id: string,
  ) {
    return this.cards.listContactCards(id, request.user);
  }

  @Post('contacts/:id/cards/sales/claim') claimSalesCard(
    @Req() request: AuthedRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.cards.claimSalesCard(id, body, request.user);
  }

  @Post('contacts/:id/cards/sales/assign') assignSalesCard(
    @Req() request: AuthedRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.cards.assignSalesCard(id, body, request.user);
  }

  @Post('contacts/:id/cards/support/open') openSupportCard(
    @Req() request: AuthedRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.cards.openSupportCard(id, body, request.user);
  }

  @Patch('crm/cards/:id') moveCardStage(
    @Req() request: AuthedRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.cards.moveCardStage(id, body, request.user);
  }

  @Post('crm/cards/:id/transfer') transferCard(
    @Req() request: AuthedRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.cards.transferCard(id, body, request.user);
  }

  @Post('crm/cards/:id/close') closeCard(
    @Req() request: AuthedRequest,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.cards.closeCard(id, body, request.user);
  }

  @Get('crm/cards/:id/movements') getCardMovements(
    @Req() request: AuthedRequest,
    @Param('id') id: string,
  ) {
    return this.cards.getCardMovements(id, request.user);
  }
}
