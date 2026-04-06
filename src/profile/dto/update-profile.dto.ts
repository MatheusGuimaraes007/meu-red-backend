import { IsOptional, IsString, IsBoolean, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateProfileDto {
  @ApiPropertyOptional({ enum: ['sedentario', 'moderado', 'atleta'] })
  @IsOptional()
  @IsString()
  @IsIn(['sedentario', 'moderado', 'atleta'])
  activity?: string;

  @ApiPropertyOptional({ enum: ['ruim', 'ok', 'boa'] })
  @IsOptional()
  @IsString()
  @IsIn(['ruim', 'ok', 'boa'])
  sleep?: string;

  @ApiPropertyOptional({ enum: ['nenhuma', 'leve', 'moderada'] })
  @IsOptional()
  @IsString()
  @IsIn(['nenhuma', 'leve', 'moderada'])
  pain?: string;

  @ApiPropertyOptional({ enum: ['sono', 'recuperacao', 'dor', 'foco', 'pele'] })
  @IsOptional()
  @IsString()
  @IsIn(['sono', 'recuperacao', 'dor', 'foco', 'pele'])
  goal?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  onboardingDone?: boolean;

  @ApiPropertyOptional({ enum: ['red-300', 'red-600', 'red-1000'] })
  @IsOptional()
  @IsString()
  @IsIn(['red-300', 'red-600', 'red-1000'])
  selectedPanel?: string;
}
