import { Transform } from 'class-transformer';
import { IsIn, IsString, IsUUID, Length } from 'class-validator';

const feedbackCategories = ['bug', 'complaint', 'suggestion'] as const;
export type FeedbackCategory = (typeof feedbackCategories)[number];

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
}
