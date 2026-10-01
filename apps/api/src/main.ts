import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { configureApp } from './configure-app.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  app.enableShutdownHooks();
  const config = app.get(ConfigService);
  const port = config.getOrThrow<number>('API_PORT');
  const host = config.getOrThrow<string>('API_HOST');
  await app.listen(port, host);
  new Logger('Bootstrap').log(`API disponible en http://${host}:${port}/api/v1/health`);
}

bootstrap().catch(() => {
  new Logger('Bootstrap').error(
    'No se pudo iniciar la API. Revisar configuración y disponibilidad del puerto.',
  );
  process.exitCode = 1;
});
