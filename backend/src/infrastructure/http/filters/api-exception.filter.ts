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
import { GoogleMfaRequiredException } from '../auth/google-mfa.constants';
import {
  IdempotencyPayloadConflictError,
  PantryMutationConflictError,
  PantryQuotaExceededError,
  SavedShoppingListLimitError,
} from '../../../application/ports/pantry-mutation.port';
import { HouseholdMemberLimitError } from '../../../domain/repositories/household.repository';
import { PlusRequiredException } from '../../../application/use-cases/get-plus-household-summary.use-case';
import { HouseholdAlreadyMemberException } from '../../../application/use-cases/household.use-cases';
import type { HouseholdRole } from '../../../domain/entities/household.entity';

interface ApiErrorBody {
  statusCode: number;
  message: string | string[];
  path: string;
  requestId?: string;
  timestamp: string;
  code?: string;
  role?: HouseholdRole;
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
    const code = getErrorCode(exception);
    const body: ApiErrorBody = {
      statusCode,
      message,
      path,
      requestId,
      timestamp: new Date().toISOString(),
      ...(code ? { code } : {}),
      ...(exception instanceof HouseholdAlreadyMemberException
        ? { role: exception.role }
        : {}),
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
  if (isClientConflict(exception)) return HttpStatus.CONFLICT;
  if (exception instanceof HttpException) {
    return exception.getStatus();
  }

  if (exception instanceof Error && isDomainValidationError(exception)) {
    return HttpStatus.BAD_REQUEST;
  }

  return HttpStatus.INTERNAL_SERVER_ERROR;
}

function getErrorCode(exception: unknown): string | undefined {
  if (exception instanceof GoogleMfaRequiredException) return exception.code;
  if (exception instanceof PlusRequiredException) return exception.code;
  if (exception instanceof HouseholdAlreadyMemberException)
    return exception.code;
  if (exception instanceof HouseholdMemberLimitError)
    return 'HOUSEHOLD_MEMBER_LIMIT';
  if (exception instanceof SavedShoppingListLimitError)
    return 'SAVED_LIST_LIMIT';
  return undefined;
}

function getClientMessage(exception: unknown): string | string[] {
  if (isClientConflict(exception)) return exception.message;
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

function isClientConflict(error: unknown): error is Error {
  return (
    error instanceof IdempotencyPayloadConflictError ||
    error instanceof PantryMutationConflictError ||
    error instanceof PantryQuotaExceededError ||
    error instanceof HouseholdMemberLimitError
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
