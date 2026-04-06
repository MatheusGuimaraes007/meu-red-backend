import { Controller, Post, Get, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { EngagementService } from './engagement.service';
import { CreateEngagementDto } from './dto/create-engagement.dto';
import { JwtGuard } from '../auth/jwt.guard';
import { GetUser } from '../auth/get-user.decorator';

@ApiTags('Engagement')
@ApiBearerAuth()
@Controller('engagement')
@UseGuards(JwtGuard)
export class EngagementController {
  constructor(private engagementService: EngagementService) { }

  @Post()
  @ApiOperation({ summary: 'Registrar evento de engajamento' })
  @ApiResponse({ status: 201, description: 'Evento criado' })
  create(
    @GetUser('id') userId: string,
    @Body() dto: CreateEngagementDto,
  ) {
    return this.engagementService.create(userId, dto);
  }

  @Get('next')
  @ApiOperation({ summary: 'Próxima ação de engajamento sugerida' })
  @ApiResponse({ status: 200, description: 'Ação retornada' })
  getNextAction(@GetUser('id') userId: string) {
    return this.engagementService.getNextAction(userId);
  }
}
