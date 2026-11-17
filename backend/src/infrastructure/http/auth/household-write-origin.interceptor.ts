import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';
import { householdWriteOrigin } from '../../../application/services/household-switch-access.service';

@Injectable()
export class HouseholdWriteOriginInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const path = request.url.split('?', 1)[0].replace(/\/$/, '');
    if (
      /^(GET|HEAD|OPTIONS)$/.test(request.method) ||
      !/\/(?:pantry|products|product-types|inventory-lots|profile\/pantry-data)(?:\/|$)/.test(
        path,
      )
    ) {
      return next.handle();
    }

    const origin = request.headers['x-despensa-household'];
    const scope = {
      ...(typeof origin === 'string' && origin ? { householdId: origin } : {}),
      checkout: /\/pantry\/checkout$/.test(path),
    };
    return new Observable((subscriber) =>
      householdWriteOrigin.run(scope, () =>
        next.handle().subscribe(subscriber),
      ),
    );
  }
}
