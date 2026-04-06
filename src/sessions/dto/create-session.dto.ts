import {
  IsString,
  IsInt,
  IsBoolean,
  IsOptional,
  IsDateString,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateSessionDto {
  @ApiPropertyOptional({ example: 'protocol-001' })
  @IsOptional()
  @IsString()
  protocolId?: string;

  @ApiPropertyOptional({ example: 'Anti-inflamatório' })
  @IsOptional()
  @IsString()
  protocolName?: string;

  @ApiPropertyOptional({ example: 'recuperacao' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiProperty({ example: 600, minimum: 1 })
  @IsInt()
  @Min(1)
  durationSeconds: number;

  @ApiProperty({ example: 600, minimum: 1 })
  @IsInt()
  @Min(1)
  targetDurationSeconds: number;

  @ApiProperty({ example: true })
  @IsBoolean()
  completed: boolean;

  @ApiProperty({ example: '2025-03-24' })
  @IsDateString()
  sessionDate: string;
}
