import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { IsEmail, IsString, MinLength } from 'class-validator';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt.guard';

class LoginDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(8) password!: string;
}

class RefreshDto {
  @IsString() @MinLength(32) refreshToken!: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  login(@Body() body: LoginDto, @Req() request: Request) {
    return this.auth.login(body.email, body.password, this.context(request));
  }

  @Post('refresh')
  refresh(@Body() body: RefreshDto, @Req() request: Request) {
    return this.auth.refresh(body.refreshToken, this.context(request));
  }

  @Post('logout')
  logout(@Body() body: RefreshDto) {
    return this.auth.logout(body.refreshToken);
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout-all')
  logoutAll(@Req() request: Request & { user: { sub: string } }) {
    return this.auth.logoutAll(request.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Req() request: Request & { user: { sub: string } }) {
    return this.auth.me(request.user.sub);
  }

  private context(request: Request) {
    return {
      userAgent: request.get('user-agent')?.slice(0, 500),
      ipAddress: request.ip,
    };
  }
}
