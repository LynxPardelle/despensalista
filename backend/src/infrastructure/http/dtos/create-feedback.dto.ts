import { Transform } from 'class-transformer';
import { IsIn, IsString, IsUUID, Length, ValidateIf } from 'class-validator';

const feedbackCategories = ['bug', 'complaint', 'suggestion'] as const;
const feedbackSources = [
  'access',
  'registration',
  'recovery',
  'pantry',
  'profile',
  'share',
  'website',
  'other',
] as const;
const feedbackErrorCodes = [
  'oauth_callback',
  'email_delivery',
  'password_reset',
  'network',
  'unexpected',
] as const;
export type FeedbackCategory = (typeof feedbackCategories)[number];
export type FeedbackSource = (typeof feedbackSources)[number];
export type FeedbackErrorCode = (typeof feedbackErrorCodes)[number];

export class CreateFeedbackDto {
  @IsUUID('4')
  submissionId!: string;

  @IsIn(feedbackCategories)
  category!: FeedbackCategory;

  @Transform(({ obj }: { obj: { message?: unknown } }) => {
    const message = obj.message;
    return typeof message === 'string' ? message.trim() : message;
  })
  @IsString()
  @Length(10, 2_000)
  message!: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(feedbackSources)
  source?: FeedbackSource;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsIn(feedbackErrorCodes)
  errorCode?: FeedbackErrorCode;
}
