import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
@Module({ imports: [JwtModule.registerAsync({ inject:[ConfigService], useFactory:(c:ConfigService)=>({ secret:c.getOrThrow('JWT_SECRET'), signOptions:{ expiresIn:c.get('JWT_EXPIRES_IN','8h') as any } }) })], controllers:[AuthController], providers:[AuthService,JwtStrategy], exports:[AuthService,JwtModule] }) export class AuthModule {}
