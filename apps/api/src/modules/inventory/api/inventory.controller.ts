import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import {
  catalogListQuerySchema,
  inventoryPolicyInputSchema,
  inventoryCreateReceiptSchema,
  inventoryCreateCountSchema,
  inventoryHeaderSchema,
  inventoryScopeInputSchema,
  inventoryLineInputSchema,
  inventoryConfirmSchema,
  inventoryVersionSchema,
  inventoryAdjustmentSchema,
} from '@maxbio/contracts';
import type { AuthenticatedRequest } from '../../../common/auth/request-context.js';
import { Roles } from '../../../common/auth/roles.decorator.js';
import { InventoryService, type DocumentKind } from '../application/inventory.service.js';
const uuid = new ParseUUIDPipe({ version: '4' });
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success)
    throw new BadRequestException(
      'Revisá los campos, las cantidades y la unidad. No se aceptan campos adicionales.',
    );
  return r.data;
}
function kind(value: string): DocumentKind {
  if (value !== 'receipts' && value !== 'counts') throw new NotFoundException();
  return value;
}
function actor(r: AuthenticatedRequest) {
  if (!r.identity.context) throw new BadRequestException('Elegí una organización.');
  return r.identity.context;
}
@Controller('inventory')
export class InventoryController {
  constructor(@Inject(InventoryService) private readonly inventory: InventoryService) {}
  @Get('stock') stock(@Req() r: AuthenticatedRequest, @Query() q: unknown) {
    return this.inventory.stock(actor(r), parse(catalogListQuerySchema, q));
  }
  @Get('products/:id') detail(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Query() q: unknown,
  ) {
    return this.inventory.detail(actor(r), id, parse(catalogListQuerySchema, q));
  }
  @Get('products/:id/history') history(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Query() q: unknown,
  ) {
    return this.inventory.history(actor(r), id, parse(catalogListQuerySchema, q));
  }
  @Get('products/:id/policy') async policy(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Res() response: Response,
  ) {
    return response.json(await this.inventory.getPolicy(actor(r), id));
  }
  @Put('products/:id/policy') @Roles('ADMIN') updatePolicy(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() b: unknown,
  ) {
    return this.inventory.setPolicy(actor(r), id, parse(inventoryPolicyInputSchema, b));
  }
  @Post('adjustments') @HttpCode(200) @Roles('ADMIN') adjust(
    @Req() r: AuthenticatedRequest,
    @Body() b: unknown,
  ) {
    return this.inventory.adjust(actor(r), parse(inventoryAdjustmentSchema, b));
  }
  @Get(':kind') list(
    @Req() r: AuthenticatedRequest,
    @Param('kind') k: string,
    @Query() q: unknown,
  ) {
    return this.inventory.listDocuments(actor(r), kind(k), parse(catalogListQuerySchema, q));
  }
  @Post(':kind') @HttpCode(200) create(
    @Req() r: AuthenticatedRequest,
    @Param('kind') k: string,
    @Body() b: unknown,
  ) {
    const d = kind(k);
    return this.inventory.createDocument(
      actor(r),
      d,
      d === 'receipts'
        ? parse(inventoryCreateReceiptSchema, b)
        : parse(inventoryCreateCountSchema, b),
    );
  }
  @Get(':kind/:id') document(
    @Req() r: AuthenticatedRequest,
    @Param('kind') k: string,
    @Param('id', uuid) id: string,
  ) {
    return this.inventory.getDocument(actor(r), kind(k), id);
  }
  @Patch(':kind/:id') header(
    @Req() r: AuthenticatedRequest,
    @Param('kind') k: string,
    @Param('id', uuid) id: string,
    @Body() b: unknown,
  ) {
    return this.inventory.updateHeader(actor(r), kind(k), id, parse(inventoryHeaderSchema, b));
  }
  @Post('counts/:id/scopes') @HttpCode(200) scope(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() b: unknown,
  ) {
    return this.inventory.addScope(actor(r), id, parse(inventoryScopeInputSchema, b));
  }
  @Put(':kind/:id/lines/:lineId') line(
    @Req() r: AuthenticatedRequest,
    @Param('kind') k: string,
    @Param('id', uuid) id: string,
    @Param('lineId', uuid) lineId: string,
    @Body() b: unknown,
  ) {
    return this.inventory.putLine(
      actor(r),
      kind(k),
      id,
      lineId,
      parse(inventoryLineInputSchema, b),
    );
  }
  @Delete(':kind/:id/lines/:lineId') remove(
    @Req() r: AuthenticatedRequest,
    @Param('kind') k: string,
    @Param('id', uuid) id: string,
    @Param('lineId', uuid) lineId: string,
    @Body() b: unknown,
  ) {
    return this.inventory.removeLine(
      actor(r),
      kind(k),
      id,
      lineId,
      parse(inventoryVersionSchema, b).expectedVersion,
    );
  }
  @Post(':kind/:id/confirm') @HttpCode(200) confirm(
    @Req() r: AuthenticatedRequest,
    @Param('kind') k: string,
    @Param('id', uuid) id: string,
    @Body() b: unknown,
  ) {
    return this.inventory.confirm(actor(r), kind(k), id, parse(inventoryConfirmSchema, b));
  }
  @Post(':kind/:id/cancel') @HttpCode(200) cancel(
    @Req() r: AuthenticatedRequest,
    @Param('kind') k: string,
    @Param('id', uuid) id: string,
    @Body() b: unknown,
  ) {
    return this.inventory.cancel(
      actor(r),
      kind(k),
      id,
      parse(inventoryVersionSchema, b).expectedVersion,
    );
  }
}
