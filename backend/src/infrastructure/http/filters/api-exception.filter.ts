import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getRequestId } from '../request-id';
import {
  IdempotencyPayloadConflictError,
  PantryMutationConflictError,
  PantryQuotaExceededError,
} from '../../../application/ports/pantry-mutation.port';

interface ApiErrorBody {
  statusCode: number;
  message: string | string[];
  path: string;
  requestId?: string;
  timestamp: string;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<FastifyRequest>();
    const reply = context.getResponse<FastifyReply>();
    const requestId = getRequestId(request);
    const statusCode = getStatusCode(exception);
    const path = (request.routeOptions?.url ?? request.url)
      .split(/[?#]/, 1)[0]
      .replace(/(\/shopping-shares\/)[^/]+/g, '$1:token');
    const message =
      statusCode >= 500 ? 'Internal server error' : getClientMessage(exception);
    const body: ApiErrorBody = {
      statusCode,
      message,
      path,
      requestId,
      timestamp: new Date().toISOString(),
    };

    if (statusCode >= 500) {
      this.logger.error(
        `Unhandled request error ${request.method} ${path} requestId=${requestId ?? 'none'} error=${exception instanceof Error ? exception.constructor.name : 'UnknownError'}`,
        exception instanceof Error
          ? exception.stack
              ?.split('\n')
              .filter((line) => /^\s+at /u.test(line))
              .join('\n')
          : undefined,
      );
    } else {
      this.logger.warn(
        `Request rejected ${statusCode} ${request.method} ${path} requestId=${requestId ?? 'none'}`,
      );
    }

    reply.status(statusCode).send(body);
  }
}

function getStatusCode(exception: unknown): number {
  if (isPantryConflict(exception)) return HttpStatus.CONFLICT;
  if (exception instanceof HttpException) {
    return exception.getStatus();
  }

  if (exception instanceof Error && isDomainValidationError(exception)) {
    return HttpStatus.BAD_REQUEST;
  }

  return HttpStatus.INTERNAL_SERVER_ERROR;
}

function getClientMessage(exception: unknown): string | string[] {
  if (isPantryConflict(exception)) return exception.message;
  if (exception instanceof HttpException) {
    const response = exception.getResponse();

    if (typeof response === 'string') {
      return response;
    }

    if (isRecord(response)) {
      const message = response['message'];

      if (typeof message === 'string') {
        return message;
      }

      if (
        Array.isArray(message) &&
        message.every((item) => typeof item === 'string')
      ) {
        return message;
      }
    }
  }

  if (exception instanceof Error && isDomainValidationError(exception)) {
    return exception.message;
  }

  return 'Request failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPantryConflict(error: unknown): error is Error {
  return (
    error instanceof IdempotencyPayloadConflictError ||
    error instanceof PantryMutationConflictError ||
    error instanceof PantryQuotaExceededError
  );
}

function isDomainValidationError(error: Error): boolean {
  return [
    /cannot be empty/i,
    /must be/i,
    /must match/i,
    /exceeds/i,
    /^unsupported /i,
    /^quantity /i,
    /^title /i,
    /^email /i,
    /^username /i,
  ].some((pattern) => pattern.test(error.message));
}
