import { Body, Controller, Delete, ForbiddenException, Get, Headers, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { IntegrationsService } from './integrations.service';

type AuthRequest = Request & { user: { sub: string; role: string } };

@UseGuards(JwtAuthGuard)
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get() list(@Req() req: AuthRequest) { this.admin(req); return this.integrations.list(); }
  @Get('options') options(@Req() req: AuthRequest) { this.admin(req); return this.integrations.options(); }
  @Get('deliveries') deliveries(@Req() req: AuthRequest) { this.admin(req); return this.integrations.deliveries(); }
  @Post() create(@Req() req: AuthRequest, @Body() body: Record<string, unknown>) { this.admin(req); return this.integrations.create(body); }
  @Patch(':id') update(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) { this.admin(req); return this.integrations.update(id, body); }
  @Delete(':id') remove(@Req() req: AuthRequest, @Param('id') id: string) { this.admin(req); return this.integrations.remove(id); }
  @Post(':id/rotate-token') rotate(@Req() req: AuthRequest, @Param('id') id: string) { this.admin(req); return this.integrations.rotateToken(id); }
  @Post(':id/automations') automation(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) { this.admin(req); return this.integrations.saveAutomation(id, body); }
  @Delete(':id/automations/:automationId') removeAutomation(@Req() req: AuthRequest, @Param('id') id: string, @Param('automationId') automationId: string) { this.admin(req); return this.integrations.removeAutomation(id, automationId); }

  private admin(req: AuthRequest) {
    if (!['master', 'admin'].includes(req.user.role)) throw new ForbiddenException('Sem permissão administrativa');
  }
}

@Controller('public/integrations')
export class PublicIntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Post(':publicId/leads')
  receive(
    @Param('publicId') publicId: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-api-key') apiKey: string | undefined,
    @Headers('x-idempotency-key') idempotencyKey: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    return this.integrations.receiveLead(publicId, bearer || apiKey, idempotencyKey, body);
  }
}
