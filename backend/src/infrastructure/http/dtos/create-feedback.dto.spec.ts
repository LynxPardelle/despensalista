import {
  ArgumentMetadata,
  BadRequestException,
  ValidationPipe,
} from '@nestjs/common';
import { CreateFeedbackDto } from './create-feedback.dto';

describe('CreateFeedbackDto', () => {
  const submission = {
    submissionId: '1f37dc5e-d32b-4bf7-936a-bda451ca7afe',
    category: 'bug',
    message: 'No se pudo guardar la lista de compras.',
  };
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const metadata: ArgumentMetadata = {
    type: 'body',
    metatype: CreateFeedbackDto,
  };

  it('trims the message before applying the length constraint', async () => {
    await expect(
      pipe.transform(
        { ...submission, message: `  ${submission.message}\n` },
        metadata,
      ),
    ).resolves.toMatchObject(submission);
  });

  it('accepts the fixed source and error code for support triage', async () => {
    const feedback = {
      ...submission,
      source: 'registration',
      errorCode: 'email_delivery',
    };
    await expect(pipe.transform(feedback, metadata)).resolves.toMatchObject(
      feedback,
    );
  });

  it.each([
    { category: 'other' },
    { message: '      \n' },
    { message: 123456789012345 },
    { message: 'a'.repeat(2001) },
    { submissionId: 'not-a-uuid' },
    { email: 'persona@example.com' },
    { source: '/login?account=personal' },
    { source: null },
    { errorCode: 'arbitrary server message' },
    { errorCode: null },
    { url: 'https://despensalista.com/pantry' },
    { userAgent: 'Personal diagnostic data' },
  ])('rejects malformed or unrecognized fields (%j)', async (changes) => {
    await expect(
      pipe.transform({ ...submission, ...changes }, metadata),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
