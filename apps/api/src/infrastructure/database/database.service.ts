import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDatabaseClient } from '@maxbio/database';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly client;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.client = createDatabaseClient(config.getOrThrow<string>('DATABASE_URL'));
  }

  async ping(): Promise<void> {
    await this.client.$queryRaw`SELECT 1`;
  }

  async onModuleDestroy() {
    await this.client.$disconnect();
  }
}
