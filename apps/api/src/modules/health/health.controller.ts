import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from '../../common/auth/public.decorator.js';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly service: HealthService) {}

  @Public()
  @Get('live')
  liveness() {
    return { status: 'ok', service: 'maxbio-api' };
  }

  @Public()
  @Get()
  readiness() {
    return this.service.readiness();
  }
}
