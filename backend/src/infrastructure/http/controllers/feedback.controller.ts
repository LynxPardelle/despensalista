import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  Header,
  Injectable,
  Post,
  UnsupportedMediaTypeException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import { FeedbackStore } from '../../feedback/feedback.store';
import { AccessTokenGuard } from '../auth/access-token.guard';
import type { AuthenticatedUser } from '../auth/authenticated-user.interface';
import { CurrentUser } from '../auth/current-user.decorator';
import { CreateFeedbackDto } from '../dtos/create-feedback.dto';

@Controller('feedback')
@UseGuards(AccessTokenGuard)
export class FeedbackController {
  constructor(private readonly feedback: FeedbackStore) {}

  @Get('status')
  @Header('Cache-Control', 'no-store')
  status() {
    return { available: this.feedback.available };
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateFeedbackDto,
  ) {
    return this.feedback.submit(user.userId, body);
  }
}

@Injectable()
class AnonymousFeedbackRequestGuard implements CanActivate {
  private readonly origins: string[];

  constructor(config: ConfigService) {
    this.origins = (
      config.get<string>('CORS_ORIGIN') ?? 'http://localhost:4200'
    )
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
  }

  canActivate(context: ExecutionContext): boolean {
    const { headers } = context.switchToHttp().getRequest<FastifyRequest>();
    const origin = headers.origin;
    const fetchSite = headers['sec-fetch-site'];
    if (
      !origin ||
      !this.origins.includes(origin) ||
      (fetchSite !== undefined && fetchSite !== 'same-origin')
    ) {
      throw new ForbiddenException('Invalid feedback origin');
    }

    const mediaType = headers['content-type']
      ?.split(';', 1)[0]
      .trim()
      .toLowerCase();
    if (mediaType !== 'application/json') {
      throw new UnsupportedMediaTypeException(
        'Feedback requires application/json',
      );
    }
    return true;
  }
}

@Controller('feedback/anonymous')
export class AnonymousFeedbackController {
  constructor(private readonly feedback: FeedbackStore) {}

  @Get('status')
  @Header('Cache-Control', 'no-store')
  status() {
    return { available: this.feedback.available };
  }

  @Post()
  @UseGuards(AnonymousFeedbackRequestGuard)
  @Header('Cache-Control', 'no-store')
  submit(@Body() body: CreateFeedbackDto) {
    return this.feedback.submitAnonymous(body);
  }
}
