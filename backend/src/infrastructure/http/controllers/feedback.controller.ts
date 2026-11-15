import { Body, Controller, Get, Header, Post, UseGuards } from '@nestjs/common';
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
