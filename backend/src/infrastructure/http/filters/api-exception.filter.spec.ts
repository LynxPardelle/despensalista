import { ArgumentsHost, BadRequestException, Logger } from '@nestjs/common';
import { ApiExceptionFilter } from './api-exception.filter';

describe('ApiExceptionFilter', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([true, false])(
    'omits OAuth queries, share tokens, cookies, and exception messages from logs (registered route: %s)',
    (registered) => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const reply = makeReply();
      const request = {
        method: 'GET',
        url: '/api/shopping-shares/private-token?code=private-code&state=private-state',
        headers: { cookie: 'session=private-cookie' },
        routeOptions: registered ? { url: '/api/shopping-shares/:token' } : {},
      };
      const host = {
        switchToHttp: () => ({
          getRequest: () => request,
          getResponse: () => reply,
        }),
      } as unknown as ArgumentsHost;
      const filter = new ApiExceptionFilter();

      filter.catch(new BadRequestException('Invalid request'), host);
      filter.catch(
        new Error('upstream URL ?code=private-code cookie=private-cookie'),
        host,
      );

      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/api/shopping-shares/:token' }),
      );
      expect(
        JSON.stringify([
          warn.mock.calls,
          error.mock.calls,
          reply.send.mock.calls,
        ]),
      ).not.toMatch(/private-(token|code|state|cookie)/);
    },
  );

  it('preserves safe client errors and includes the request id', () => {
    const reply = makeReply();
    const filter = new ApiExceptionFilter();

    filter.catch(
      new BadRequestException('Invalid quantity'),
      makeHost(reply, 'req-12345678'),
    );

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Invalid quantity',
        path: '/api/inventory-lots',
        requestId: 'req-12345678',
        statusCode: 400,
      }),
    );
  });

  it('maps known domain validation errors to 400', () => {
    const reply = makeReply();
    const filter = new ApiExceptionFilter();

    filter.catch(
      new Error('Consume amount exceeds lot quantity'),
      makeHost(reply, 'req-12345678'),
    );

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Consume amount exceeds lot quantity',
        statusCode: 400,
      }),
    );
  });

  it('sanitizes unexpected errors', () => {
    const reply = makeReply();
    const filter = new ApiExceptionFilter();

    filter.catch(new Error('database password leaked'), makeHost(reply));

    expect(reply.status).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Internal server error',
        statusCode: 500,
      }),
    );
  });
});

function makeReply(): {
  status: jest.Mock;
  send: jest.Mock;
} {
  const reply = {
    status: jest.fn(),
    send: jest.fn(),
  };
  reply.status.mockReturnValue(reply);
  return reply;
}

function makeHost(
  reply: ReturnType<typeof makeReply>,
  requestId?: string,
): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: requestId ? { 'x-request-id': requestId } : {},
        method: 'POST',
        url: '/api/inventory-lots',
      }),
      getResponse: () => reply,
    }),
  } as unknown as ArgumentsHost;
}
