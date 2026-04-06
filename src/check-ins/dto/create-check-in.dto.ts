import { IsInt, IsDateString, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateCheckInDto {
  @ApiProperty({ example: 3, minimum: 0, maximum: 10 })
  @IsInt()
  @Min(0)
  @Max(10)
  pain: number;

  @ApiProperty({ example: 7, minimum: 0, maximum: 10 })
  @IsInt()
  @Min(0)
  @Max(10)
  energy: number;

  @ApiProperty({ example: 6, minimum: 0, maximum: 10 })
  @IsInt()
  @Min(0)
  @Max(10)
  sleep: number;

  @ApiProperty({ example: 8, minimum: 0, maximum: 10 })
  @IsInt()
  @Min(0)
  @Max(10)
  recovery: number;

  @ApiProperty({ example: '2025-03-24' })
  @IsDateString()
  date: string;
}
