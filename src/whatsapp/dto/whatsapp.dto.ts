import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateWhatsappInstanceDto {
  @IsString() @MinLength(2) @MaxLength(100) instanceName!: string;
  @IsOptional() @IsBoolean() lite?: boolean;
  @IsOptional() @IsBoolean() automaticReading?: boolean;
  @IsOptional() @IsBoolean() rejectCalls?: boolean;
  @IsOptional() @IsString() @MaxLength(500) callMessage?: string;
  @IsOptional() @IsBoolean() useProxy?: boolean;
  @IsOptional() @IsString() proxyProtocol?: string;
  @IsOptional() @IsString() proxyHost?: string;
  @IsOptional() @IsString() proxyPort?: string;
  @IsOptional() @IsString() proxyUser?: string;
  @IsOptional() @IsString() proxyPass?: string;
}

export class UpdateWhatsappInstanceDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(100) instanceName?: string;
  @IsOptional() @IsString() @Matches(/^\d{8,20}$/) displayPhoneNumber?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() automaticReading?: boolean;
  @IsOptional() @IsBoolean() rejectCalls?: boolean;
  @IsOptional() @IsString() @MaxLength(500) callMessage?: string;
}

export class UpdateWhatsappStatusDto {
  @IsString()
  @IsIn(['PENDING', 'CONNECTED', 'DISCONNECTED', 'EXPIRED', 'BLOCKED'])
  status!: string;
}
