import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  Post,
  Req,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import {
  identificationConfirmSchema,
  scanInputSchema,
  catalogListQuerySchema,
} from '@maxbio/contracts';
import type { AuthenticatedRequest } from '../../../common/auth/request-context.js';
import { IdentificationService } from '../application/identification.service.js';

@Controller()
export class IdentificationController {
  constructor(
    @Inject(IdentificationService) private readonly identification: IdentificationService,
  ) {}
  @Get('products/:id/supplier-scan-identifiers')
  externalIdentifiers(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: unknown,
  ) {
    const input = catalogListQuerySchema.safeParse(query);
    if (!input.success) throw new BadRequestException('Revisá los filtros y el tamaño de página.');
    if (!request.identity.context) throw new ForbiddenException('Elegí una organización.');
    return this.identification.listSupplierIdentifiers(request.identity.context, id, input.data);
  }
  @Post('catalog-scans/resolve')
  @HttpCode(200)
  resolve(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = scanInputSchema.safeParse(body);
    if (!input.success)
      throw new BadRequestException(
        'Revisá la lectura y el proveedor. No se aceptan campos adicionales.',
      );
    if (!request.identity.context) throw new ForbiddenException('Elegí una organización.');
    return this.identification.resolve(request.identity.context, input.data);
  }
  @Post('catalog-identifications/confirm')
  @HttpCode(200)
  confirm(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = identificationConfirmSchema.safeParse(body);
    if (!input.success)
      throw new BadRequestException('Revisá los datos y las versiones antes de confirmar.');
    if (!request.identity.context) throw new ForbiddenException('Elegí una organización.');
    return this.identification.confirm(request.identity.context, input.data);
  }
}
