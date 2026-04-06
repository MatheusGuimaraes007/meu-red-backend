import { Controller, Get, Put, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ProfileService } from './profile.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { JwtGuard } from '../auth/jwt.guard';
import { GetUser } from '../auth/get-user.decorator';

@ApiTags('Profile')
@ApiBearerAuth()
@Controller('profile')
@UseGuards(JwtGuard)
export class ProfileController {
  constructor(private profileService: ProfileService) { }

  @Get()
  @ApiOperation({ summary: 'Obter perfil do usuário' })
  @ApiResponse({ status: 200, description: 'Perfil retornado' })
  getProfile(@GetUser('id') userId: string) {
    return this.profileService.getProfile(userId);
  }

  @Put()
  @ApiOperation({ summary: 'Atualizar perfil (upsert)' })
  @ApiResponse({ status: 200, description: 'Perfil atualizado' })
  updateProfile(
    @GetUser('id') userId: string,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.profileService.updateProfile(userId, dto);
  }
}
