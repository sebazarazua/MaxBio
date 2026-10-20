import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { json } from 'express';
import helmet from 'helmet';
import { HttpErrorFilter } from './common/http/http-error.filter.js';

export function configureApp(app: INestApplication) {
  app.setGlobalPrefix('api/v1');
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.use(helmet());
  // Only this authenticated endpoint accepts prepared PNGs as bounded base64 JSON.
  app.use('/api/v1/printing/assets', json({ limit: 5700000 }));
  // Nest detects the route-local jsonParser by name and skips its automatic one.
  // Register the usual parser explicitly for every other JSON endpoint.
  app.use(json());
  app.use((_request: Request, response: Response, next: NextFunction) => {
    const requestId = randomUUID();
    response.locals.requestId = requestId;
    response.setHeader('X-Request-Id', requestId);
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transform: true,
      validationError: { target: false, value: false },
    }),
  );
  app.useGlobalFilters(new HttpErrorFilter());
}
