import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { SessionsService } from './sessions.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { JwtGuard } from '../auth/jwt.guard';
import { GetUser } from '../auth/get-user.decorator';

@ApiTags('Sessions')
@ApiBearerAuth()
@Controller('sessions')
@UseGuards(JwtGuard)
export class SessionsController {
  constructor(private sessionsService: SessionsService) { }

  @Post()
  @ApiOperation({ summary: 'Registrar nova sessão' })
  @ApiResponse({ status: 201, description: 'Sessão criada' })
  create(
    @GetUser('id') userId: string,
    @Body() dto: CreateSessionDto,
  ) {
    return this.sessionsService.create(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar sessões do usuário' })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 50 })
  @ApiResponse({ status: 200, description: 'Lista de sessões' })
  findAll(
    @GetUser('id') userId: string,
    @Query('limit') limit?: string,
  ) {
    return this.sessionsService.findAll(userId, limit ? parseInt(limit, 10) : 50);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Estatísticas de sessões (streak, weekly, etc.)' })
  @ApiResponse({ status: 200, description: 'Estatísticas retornadas' })
  getStats(@GetUser('id') userId: string) {
    return this.sessionsService.getStats(userId);
  }
}
