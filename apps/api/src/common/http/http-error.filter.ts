import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ApiError } from '@maxbio/contracts';

const codes: Record<number, string> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  503: 'SERVICE_UNAVAILABLE',
};

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const requestId = String(response.locals.requestId);
    let message = 'Ocurrió un error inesperado. Volvé a intentar.';
    let details: string[] | undefined;
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null && 'message' in body) {
        const content = body.message;
        if (
          Array.isArray(content) &&
          content.every((item): item is string => typeof item === 'string')
        ) {
          message = 'Revisá los datos ingresados.';
          details = content;
        } else if (typeof content === 'string') message = content;
      }
      if (status === 404) message = 'No encontramos lo que buscás.';
    }
    if (status >= 500) {
      message =
        status === 503
          ? 'La conexión del sistema no está disponible. Volvé a intentar.'
          : 'Ocurrió un error inesperado. Volvé a intentar.';
      details = undefined;
      // Sin cuerpos, tokens, URLs de conexión ni mensajes de drivers en logs.
      this.logger.error({ requestId, status, event: 'http_request_failed' });
    }
    const body: ApiError = {
      statusCode: status,
      code: codes[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
      message,
      requestId,
      timestamp: new Date().toISOString(),
      path: request.path,
      ...(details ? { details } : {}),
    };
    response.status(status).json(body);
  }
}
