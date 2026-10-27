import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
} from '@nestjs/common';
import { traceabilityQuerySchema } from '@maxbio/contracts';
import type { AuthenticatedRequest } from '../../../common/auth/request-context.js';
import { TraceabilityService } from '../application/traceability.service.js';
const uuid = new ParseUUIDPipe({ version: '4' });
function actor(r: AuthenticatedRequest) {
  if (!r.identity.context) throw new ForbiddenException('Elegí una organización para continuar.');
  return r.identity.context;
}
// Read-only: same ADMIN/OPERATOR access as reading Remitos. Organization comes only from the session.
@Controller('traceability')
export class TraceabilityController {
  constructor(@Inject(TraceabilityService) private readonly service: TraceabilityService) {}
  @Get() search(@Req() r: AuthenticatedRequest, @Query() q: unknown) {
    const query = traceabilityQuerySchema.safeParse(q);
    if (!query.success)
      throw new BadRequestException(
        'Revisá la búsqueda, las fechas y el tamaño de página (máximo 100). No se aceptan filtros adicionales.',
      );
    return this.service.search(actor(r), query.data);
  }
  @Get(':id') detail(@Req() r: AuthenticatedRequest, @Param('id', uuid) id: string) {
    return this.service.detail(actor(r), id);
  }
}
