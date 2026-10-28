import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { z } from 'zod';
import { z as runtimeZ } from 'zod';
import {
  invoiceCreateSchema,
  invoiceListQuerySchema,
  invoicePendingQuerySchema,
  invoiceTransitionSchema,
  invoiceUpdateSchema,
  versionInputSchema,
  invoiceFiscalReceiverSchema,
} from '@maxbio/contracts';
import type { AuthenticatedRequest } from '../../../common/auth/request-context.js';
import { Roles } from '../../../common/auth/roles.decorator.js';
import { InvoicingService } from '../application/invoicing.service.js';
import { InvoiceFiscalService } from '../application/invoice-fiscal.service.js';
const uuid = new ParseUUIDPipe({ version: '4' });
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new BadRequestException(
      result.error.issues.some((i) => i.path.includes('unitPrice'))
        ? 'Completá el precio unitario con un importe válido (hasta 2 decimales).'
        : 'Revisá los datos de la factura, las fechas y los filtros. No se aceptan campos adicionales.',
    );
  return result.data;
}
function actor(r: AuthenticatedRequest) {
  if (!r.identity.context) throw new ForbiddenException('Elegí una organización para continuar.');
  return r.identity.context;
}
// Reads: ADMIN and OPERATOR. Writes: ADMIN only (commercial/fiscal document).
@Controller('invoices')
export class InvoicingController {
  constructor(
    @Inject(InvoicingService) private readonly service: InvoicingService,
    @Inject(InvoiceFiscalService) private readonly fiscal: InvoiceFiscalService,
  ) {}
  @Get(':id/fiscal/readiness') @Roles('ADMIN') fiscalReadiness(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Query() q: unknown,
  ) {
    parse(runtimeZ.object({}).strict(), q);
    return this.fiscal.readiness(actor(r), id);
  }
  @Post(':id/fiscal/authorize') @HttpCode(200) @Roles('ADMIN') authorize(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    parse(runtimeZ.object({}).strict(), q);
    return this.fiscal.authorize(actor(r), id, parse(invoiceTransitionSchema, b));
  }
  @Post(':id/fiscal/receiver') @HttpCode(200) @Roles('ADMIN') receiver(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    parse(runtimeZ.object({}).strict(), q);
    return this.fiscal.setReceiver(actor(r), id, parse(invoiceFiscalReceiverSchema, b));
  }
  @Post(':id/fiscal/verify') @HttpCode(200) @Roles('ADMIN') verify(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    parse(runtimeZ.object({}).strict(), q);
    parse(runtimeZ.object({}).strict(), b);
    return this.fiscal.verify(actor(r), id);
  }
  @Get() list(@Req() r: AuthenticatedRequest, @Query() q: unknown) {
    return this.service.list(actor(r), parse(invoiceListQuerySchema, q));
  }
  @Get('pending-delivery-notes') pending(@Req() r: AuthenticatedRequest, @Query() q: unknown) {
    return this.service.pending(actor(r), parse(invoicePendingQuerySchema, q));
  }
  @Get(':id') get(@Req() r: AuthenticatedRequest, @Param('id', uuid) id: string) {
    return this.service.get(actor(r), id);
  }
  @Post() @HttpCode(200) @Roles('ADMIN') create(
    @Req() r: AuthenticatedRequest,
    @Body() b: unknown,
  ) {
    return this.service.create(actor(r), parse(invoiceCreateSchema, b));
  }
  @Patch(':id') @Roles('ADMIN') update(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() b: unknown,
  ) {
    return this.service.update(actor(r), id, parse(invoiceUpdateSchema, b));
  }
  @Post(':id/ready') @HttpCode(200) @Roles('ADMIN') ready(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() b: unknown,
  ) {
    return this.service.ready(actor(r), id, parse(invoiceTransitionSchema, b));
  }
  @Post(':id/reopen') @HttpCode(200) @Roles('ADMIN') reopen(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() b: unknown,
  ) {
    return this.service.reopen(actor(r), id, parse(invoiceTransitionSchema, b));
  }
  @Post(':id/discard') @HttpCode(200) @Roles('ADMIN') discard(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() b: unknown,
  ) {
    return this.service.discard(actor(r), id, parse(versionInputSchema, b).expectedVersion);
  }
}
