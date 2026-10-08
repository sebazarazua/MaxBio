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
  customerCreateSchema,
  customerUpdateSchema,
  customerVersionSchema,
  customerListQuerySchema,
} from '@maxbio/contracts';
import type { AuthenticatedRequest } from '../../../common/auth/request-context.js';
import { Roles } from '../../../common/auth/roles.decorator.js';
import { CustomersService } from '../application/customers.service.js';
const uuid = new ParseUUIDPipe({ version: '4' });
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const labels: Record<string, string> = {
      name: 'nombre',
      kind: 'tipo de cliente',
      cuit: 'CUIT y su dígito verificador',
      email: 'email',
      expectedVersion: 'información del cliente',
      page: 'página',
      limit: 'tamaño de página (máximo 100)',
    };
    const fields = [
      ...new Set(
        result.error.issues.map((issue) => labels[String(issue.path[0])] ?? 'datos ingresados'),
      ),
    ];
    throw new BadRequestException(`Revisá ${fields.join(', ')}. No se aceptan campos adicionales.`);
  }
  return result.data;
}
function actor(r: AuthenticatedRequest) {
  if (!r.identity.context) throw new ForbiddenException('Elegí una organización para continuar.');
  return r.identity.context;
}
@Controller('customers')
export class CustomersController {
  constructor(@Inject(CustomersService) private readonly customers: CustomersService) {}
  @Get() list(@Req() r: AuthenticatedRequest, @Query() q: unknown) {
    return this.customers.list(actor(r), parse(customerListQuerySchema, q));
  }
  @Get(':id') get(@Req() r: AuthenticatedRequest, @Param('id', uuid) id: string) {
    return this.customers.get(actor(r), id);
  }
  @Post() @HttpCode(200) @Roles('ADMIN') create(
    @Req() r: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    return this.customers.create(actor(r), parse(customerCreateSchema, body));
  }
  @Patch(':id') @Roles('ADMIN') update(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.customers.update(actor(r), id, parse(customerUpdateSchema, body));
  }
  @Post(':id/archive') @HttpCode(200) @Roles('ADMIN') archive(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.customers.state(
      actor(r),
      id,
      parse(customerVersionSchema, body).expectedVersion,
      false,
    );
  }
  @Post(':id/restore') @HttpCode(200) @Roles('ADMIN') restore(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.customers.state(
      actor(r),
      id,
      parse(customerVersionSchema, body).expectedVersion,
      true,
    );
  }
}
