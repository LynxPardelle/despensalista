import { ValidationPipe } from '@nestjs/common';
import { SignOutAllSessionsDto } from './delete-pantry-data.dto';

describe('SignOutAllSessionsDto', () => {
  it('preserves confirmationText through the application validation pipe', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    });

    const result = await pipe.transform(
      { confirmationText: 'CERRAR SESIONES' },
      { type: 'body', metatype: SignOutAllSessionsDto },
    );

    expect(result).toBeInstanceOf(SignOutAllSessionsDto);
    expect(result.confirmationText).toBe('CERRAR SESIONES');
  });
});
