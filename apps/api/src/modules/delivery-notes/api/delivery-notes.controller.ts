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
import {
  deliveryNoteCreateSchema,
  deliveryNoteUpdateSchema,
  deliveryNoteConfirmSchema,
  deliveryNoteListQuerySchema,
  versionInputSchema,
} from '@maxbio/contracts';
import type { AuthenticatedRequest } from '../../../common/auth/request-context.js';
import { Roles } from '../../../common/auth/roles.decorator.js';
import { DeliveryNotesService } from '../application/delivery-notes.service.js';
const uuid = new ParseUUIDPipe({ version: '4' });
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new BadRequestException(
      'Revisá los datos del remito, las cantidades y el número. No se aceptan campos adicionales.',
    );
  return result.data;
}
function actor(r: AuthenticatedRequest) {
  if (!r.identity.context) throw new ForbiddenException('Elegí una organización para continuar.');
  return r.identity.context;
}
@Controller('delivery-notes')
export class DeliveryNotesController {
  constructor(@Inject(DeliveryNotesService) private readonly service: DeliveryNotesService) {}
  @Post('search') @HttpCode(200) search(@Req() r: AuthenticatedRequest, @Body() body: unknown) {
    return this.service.list(actor(r), parse(deliveryNoteListQuerySchema, body));
  }
  @Get() list(@Req() r: AuthenticatedRequest, @Query() q: unknown) {
    return this.service.list(actor(r), parse(deliveryNoteListQuerySchema, q));
  }
  @Get(':id') get(@Req() r: AuthenticatedRequest, @Param('id', uuid) id: string) {
    return this.service.get(actor(r), id);
  }
  @Post() @HttpCode(200) create(@Req() r: AuthenticatedRequest, @Body() body: unknown) {
    return this.service.create(actor(r), parse(deliveryNoteCreateSchema, body));
  }
  @Patch(':id') update(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.service.update(actor(r), id, parse(deliveryNoteUpdateSchema, body));
  }
  @Post(':id/confirm') @HttpCode(200) confirm(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.service.confirm(actor(r), id, parse(deliveryNoteConfirmSchema, body));
  }
  @Post(':id/cancel') @HttpCode(200) @Roles('ADMIN') cancel(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.service.cancel(actor(r), id, parse(versionInputSchema, body).expectedVersion);
  }
}
