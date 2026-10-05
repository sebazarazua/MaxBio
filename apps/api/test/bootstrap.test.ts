import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Body, Controller, Get, HttpException, Post } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsString, MinLength } from 'class-validator';
import { apiErrorSchema, healthResponseSchema } from '@maxbio/contracts';
import { Public } from '../src/common/auth/public.decorator.js';
import { configureApp } from '../src/configure-app.js';
import { DatabaseService } from '../src/infrastructure/database/database.service.js';
import { validateEnvironment } from '../src/config/environment.js';

process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/maxbio_test';
process.env.NODE_ENV = 'test';
const { AppModule } = await import('../src/app.module.js');

class ProbeDto {
  @IsString()
  @MinLength(2)
  name!: string;
}

// Rutas exclusivas de tests: nunca se registran en producción.
@Controller('probe')
class ProbeController {
  @Get('private')
  privateRoute() {
    return { secret: true };
  }

  @Public()
  @Get('failure')
  failure() {
    throw new Error('postgresql://secret:password@private-host');
  }

  @Public()
  @Get('http-failure')
  httpFailure() {
    throw new HttpException('postgresql://secret:password@private-host', 500);
  }

  @Public()
  @Post('validate')
  validate(@Body() body: ProbeDto) {
    return body;
  }
}

let app: INestApplication;
let base: string;
let databaseAvailable = true;

before(async () => {
  const module = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [ProbeController],
  })
    .overrideProvider(DatabaseService)
    .useValue({
      ping: async () => {
        if (!databaseAvailable) throw new Error('driver secret');
      },
    })
    .compile();
  app = module.createNestApplication({ logger: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
after(async () => {
  await app?.close();
});

test('readiness verifica la dependencia y cumple el contrato', async () => {
  const response = await fetch(`${base}/api/v1/health`);
  assert.equal(response.status, 200);
  healthResponseSchema.parse(await response.json());
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('readiness falla con 503 y liveness permanece disponible', async () => {
  databaseAvailable = false;
  try {
    const ready = await fetch(`${base}/api/v1/health`);
    assert.equal(ready.status, 503);
    const error = apiErrorSchema.parse(await ready.json());
    assert.equal(error.code, 'SERVICE_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(error), /driver secret/);
    const live = await fetch(`${base}/api/v1/health/live`);
    assert.equal(live.status, 200);
  } finally {
    databaseAvailable = true;
  }
});

test('rutas no públicas rechazan acceso y no confían en headers de identidad o tenant', async () => {
  const response = await fetch(`${base}/api/v1/probe/private`, {
    headers: {
      'x-organization-id': 'another-tenant',
      'x-user-id': 'admin',
      'x-request-id': 'spoofed',
    },
  });
  assert.equal(response.status, 401);
  const error = apiErrorSchema.parse(await response.json());
  assert.equal(error.code, 'UNAUTHENTICATED');
  assert.equal(response.headers.get('x-request-id'), error.requestId);
  assert.notEqual(error.requestId, 'spoofed');
});

test('errores inesperados no exponen credenciales, stack ni mensajes internos', async () => {
  for (const route of ['failure', 'http-failure']) {
    const response = await fetch(`${base}/api/v1/probe/${route}`);
    assert.equal(response.status, 500);
    const error = apiErrorSchema.parse(await response.json());
    assert.equal(error.code, 'INTERNAL_ERROR');
    assert.doesNotMatch(JSON.stringify(error), /password|private-host|stack|postgresql/);
  }
});

test('rutas inexistentes devuelven el mismo formato de error', async () => {
  const response = await fetch(`${base}/api/v1/missing`);
  assert.equal(response.status, 404);
  assert.equal(apiErrorSchema.parse(await response.json()).code, 'NOT_FOUND');
});

test('validación rechaza campos adicionales y tipos inválidos', async () => {
  for (const body of [{ name: 'ok', organizationId: 'untrusted' }, { name: 42 }, {}]) {
    const response = await fetch(`${base}/api/v1/probe/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:3000',
        'X-Maxbio-Csrf': '1',
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
    const error = apiErrorSchema.parse(await response.json());
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.ok(error.details?.length);
  }
});

test('validación permite un DTO válido', async () => {
  const response = await fetch(`${base}/api/v1/probe/validate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://localhost:3000',
      'X-Maxbio-Csrf': '1',
    },
    body: JSON.stringify({ name: 'MaxBio' }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { name: 'MaxBio' });
});

test('configuración inválida falla sin revelar valores sensibles', () => {
  assert.throws(
    () => validateEnvironment({ DATABASE_URL: 'secret-token', API_PORT: -1 }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /DATABASE_URL/);
      assert.match(error.message, /API_PORT/);
      assert.doesNotMatch(error.message, /secret-token/);
      return true;
    },
  );
});
