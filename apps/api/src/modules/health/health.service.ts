import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { HealthResponse } from '@maxbio/contracts';
import { DatabaseService } from '../../infrastructure/database/database.service.js';

@Injectable()
export class HealthService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async readiness(): Promise<HealthResponse> {
    try {
      await this.database.ping();
    } catch {
      throw new ServiceUnavailableException(
        'La conexión del sistema no está disponible. Volvé a intentar.',
      );
    }
    return {
      status: 'ok',
      service: 'maxbio-api',
      database: 'ok',
      checkedAt: new Date().toISOString(),
    };
  }
}
