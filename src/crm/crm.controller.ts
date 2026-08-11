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
import { CrmService } from './crm.service';

@UseGuards(JwtAuthGuard)
@Controller()
export class CrmController {
  constructor(private readonly crm: CrmService) {}
  @Get('dashboard') dashboard(@Req() request: Request & { user: { sub: string; role: string } }) {
    return this.crm.dashboard(request.user);
  }
  @Get('contacts') contacts(
    @Req() request: Request & { user: { sub: string; role: string } },
    @Query('instance_id') instance?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('funnel_id') funnel?: string,
    @Query('stage_id') stage?: string,
    @Query('tag_id') tag?: string,
  ) {
    return this.crm.contacts(request.user, instance, search, page, limit, funnel, stage, tag);
  }
  @Get('funnels/:id/board-summary') boardSummary(
    @Req() request: Request & { user: { sub: string; role: string } },
    @Param('id') id: string,
    @Query('instance_id') instance?: string,
    @Query('search') search?: string,
    @Query('tag_id') tag?: string,
  ) {
    return this.crm.boardSummary(id, instance, search, tag, request.user);
  }
  @Get('contacts/:id') contact(
    @Req() request: Request & { user: { sub: string; role: string } },
    @Param('id') id: string,
  ) {
    return this.crm.contact(id, request.user);
  }
  @Post('contacts/import') importContacts(
    @Req() request: Request & { user: { sub: string; role: string } },
    @Body() body: Record<string, unknown>,
  ) {
    return this.crm.importContacts(body, request.user);
  }
  @Patch('contacts/:id') update(
    @Req() request: Request & { user: { sub: string; role: string } },
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.crm.updateContact(id, body, request.user);
  }
  @Get('contacts/:id/messages') messages(
    @Req() request: Request & { user: { sub: string; role: string } },
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.crm.messages(id, page, limit, request.user);
  }
  @Post('contacts/:id/messages') send(
    @Req() request: Request & { user: { sub: string; role: string } },
    @Param('id') id: string,
    @Body() body: Record<string, any>,
  ) {
    return this.crm.send(id, body, request.user);
  }
  @Post('messages/:id/retry') retry(@Param('id') id: string) {
    return this.crm.retry(id);
  }
  @Patch('messages/:id/edit') edit(
    @Req() request: Request & { user: { sub: string } },
    @Param('id') id: string,
    @Body('text') text: string,
  ) {
    return this.crm.editMessage(id, text, request.user.sub);
  }
  @Delete('messages/:id/delete') remove(@Param('id') id: string) {
    return this.crm.deleteMessage(id);
  }
  @Post('messages/:id/action') action(
    @Req() request: Request & { user: { sub: string } },
    @Param('id') id: string,
    @Body() body: Record<string, any>,
  ) {
    return this.crm.messageAction(id, body, request.user.sub);
  }
  @Post('contacts/:id/read') read(
    @Req() request: Request & { user: { sub: string; role: string } },
    @Param('id') id: string,
  ) {
    return this.crm.markConversationRead(id, request.user);
  }
  @Post('contacts/:id/tags/:tagId') addContactTag(
    @Req() request: Request & { user: { sub: string; role: string } },
    @Param('id') id: string,
    @Param('tagId') tagId: string,
  ) {
    return this.crm.addContactTag(id, tagId, request.user);
  }
  @Delete('contacts/:id/tags/:tagId') removeContactTag(
    @Req() request: Request & { user: { sub: string; role: string } },
    @Param('id') id: string,
    @Param('tagId') tagId: string,
  ) {
    return this.crm.removeContactTag(id, tagId, request.user);
  }
  @Get('funnels') funnels(
    @Req() request: Request & { user: { sub: string; role: string } },
    @Query('instance_id') instance?: string,
  ) {
    return this.crm.funnels(instance, request.user);
  }
  @Get('tags') tags(
    @Req() request: Request & { user: { sub: string; role: string } },
    @Query('instance_id') instance?: string,
  ) {
    return this.crm.tags(instance, request.user);
  }
  @Post('tags') createTag(
    @Req() request: Request & { user: { sub: string; role: string } },
    @Body() body: Record<string, unknown>,
  ) {
    return this.crm.createTag(body, request.user);
  }
  @Patch('tags/:id') updateTag(
    @Req() request: Request & { user: { sub: string; role: string } },
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.crm.updateTag(id, body, request.user);
  }
  @Delete('tags/:id') deleteTag(
    @Req() request: Request & { user: { sub: string; role: string } },
    @Param('id') id: string,
  ) {
    return this.crm.deleteTag(id, request.user);
  }
  @Post('funnels') createFunnel(
    @Req() request: Request & { user: { sub: string; role: string } },
    @Body() body: Record<string, unknown>,
  ) {
    return this.crm.createFunnel(body, request.user);
  }
  @Patch('funnels/:id') updateFunnel(
    @Req() request: Request & { user: { sub: string; role: string } },
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.crm.updateFunnel(id, body, request.user);
  }
  @Get('funnels/:id/available-contacts') availableFunnelContacts(
    @Req() request: Request & { user: { sub: string; role: string } },
    @Param('id') id: string,
    @Query('search') search?: string,
  ) {
    return this.crm.availableFunnelContacts(id, search, request.user);
  }
  @Post('funnels/:id/contacts') addContactsToFunnel(
    @Req() request: Request & { user: { sub: string; role: string } },
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.crm.addContactsToFunnel(id, body, request.user);
  }
  @Post('funnels/:id/stages') createStage(
    @Req() request: Request & { user: { sub: string; role: string } },
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.crm.createStage(id, body, request.user);
  }
  @Patch('stages/:id') updateStage(
    @Req() request: Request & { user: { sub: string; role: string } },
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.crm.updateStage(id, body, request.user);
  }
  @Post('stages/:id/move') moveStage(
    @Req() request: Request & { user: { sub: string; role: string } },
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.crm.moveStage(id, body, request.user);
  }
  @Delete('stages/:id') deleteStage(
    @Req() request: Request & { user: { sub: string; role: string } },
    @Param('id') id: string,
  ) {
    return this.crm.deleteStage(id, request.user);
  }
  @Get('knowledge') knowledge() {
    return this.crm.knowledge();
  }
  @Get('ai-instances') aiInstances() {
    return this.crm.aiInstances();
  }
  @Get('users') users(@Req() request: Request & { user: { role: string } }) {
    this.assertAdmin(request);
    return this.crm.users();
  }
  @Post('users') createUser(
    @Req() request: Request & { user: { role: string } },
    @Body() body: Record<string, unknown>,
  ) {
    this.assertAdmin(request);
    return this.crm.createUser(body);
  }
  @Patch('users/:id') updateUser(
    @Req() request: Request & { user: { role: string } },
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    this.assertAdmin(request);
    return this.crm.updateUser(id, body);
  }
  @Get('permission-options') permissionOptions(@Req() request: Request & { user: { role: string } }) {
    this.assertAdmin(request);
    return this.crm.permissionOptions();
  }
  @Patch('account') updateOwnAccount(
    @Req() request: Request & { user: { sub: string } },
    @Body() body: Record<string, unknown>,
  ) {
    return this.crm.updateOwnAccount(request.user.sub, body);
  }

  private assertAdmin(request: Request & { user: { role: string } }) {
    if (!['master', 'admin'].includes(request.user.role))
      throw new ForbiddenException('Sem permissão administrativa');
  }
}
