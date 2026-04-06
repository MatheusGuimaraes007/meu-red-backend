import { IsString, IsOptional, IsInt, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateEngagementDto {
  @ApiProperty({ enum: ['feedback_positive', 'feedback_negative', 'ugc_shared', 'ugc_declined', 'review_completed', 'review_declined'] })
  @IsString()
  @IsIn([
    'feedback_positive',
    'feedback_negative',
    'ugc_shared',
    'ugc_declined',
    'review_completed',
    'review_declined',
  ])
  eventType: string;

  @ApiPropertyOptional({ example: 'me ajudou com dores' })
  @IsOptional()
  @IsString()
  feedbackReason?: string;

  @ApiPropertyOptional({ example: 5 })
  @IsOptional()
  @IsInt()
  sessionCount?: number;
}
