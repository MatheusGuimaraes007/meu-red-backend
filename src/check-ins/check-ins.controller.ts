import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { CheckInsService } from './check-ins.service';
import { CreateCheckInDto } from './dto/create-check-in.dto';
import { JwtGuard } from '../auth/jwt.guard';
import { GetUser } from '../auth/get-user.decorator';

@ApiTags('Check-ins')
@ApiBearerAuth()
@Controller('check-ins')
@UseGuards(JwtGuard)
export class CheckInsController {
  constructor(private checkInsService: CheckInsService) { }

  @Post()
  @ApiOperation({ summary: 'Registrar check-in diário' })
  @ApiResponse({ status: 201, description: 'Check-in criado' })
  @ApiResponse({ status: 409, description: 'Já existe check-in para esta data' })
  create(
    @GetUser('id') userId: string,
    @Body() dto: CreateCheckInDto,
  ) {
    return this.checkInsService.create(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar check-ins' })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 14 })
  @ApiResponse({ status: 200, description: 'Lista de check-ins' })
  findAll(
    @GetUser('id') userId: string,
    @Query('limit') limit?: string,
  ) {
    return this.checkInsService.findAll(userId, limit ? parseInt(limit, 10) : 14);
  }

  @Get('trends')
  @ApiOperation({ summary: 'Tendências (comparação últimos 7 dias vs anteriores)' })
  @ApiResponse({ status: 200, description: 'Tendências retornadas' })
  getTrends(@GetUser('id') userId: string) {
    return this.checkInsService.getTrends(userId);
  }
}
