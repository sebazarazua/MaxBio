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
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { z } from 'zod';
import {
  catalogListQuerySchema,
  supplierCatalogQuerySchema,
  catalogPreviewInputSchema,
  catalogCommitInputSchema,
  catalogImportRowsQuerySchema,
  catalogAnalysisInputSchema,
  supplierCatalogLimits,
} from '@maxbio/contracts';
import type { AuthenticatedRequest } from '../../../common/auth/request-context.js';
import { Roles } from '../../../common/auth/roles.decorator.js';
import { SupplierCatalogService } from '../application/supplier-catalog.service.js';

const uuid = new ParseUUIDPipe({ version: '4' });
export function parseCatalogInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new BadRequestException(
      'Revisá las opciones, los filtros y el tamaño de página (máximo 100). No se aceptan campos adicionales.',
    );
  }
  return result.data;
}
function actor(request: AuthenticatedRequest) {
  if (!request.identity.context)
    throw new ForbiddenException('Elegí una organización para continuar.');
  return request.identity.context;
}
@Controller()
export class SupplierCatalogController {
  constructor(@Inject(SupplierCatalogService) private readonly catalog: SupplierCatalogService) {}
  @Get('suppliers/:id/catalog-items')
  supplierItems(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Query() query: unknown,
  ) {
    return this.catalog.listItems(
      actor(request),
      parseCatalogInput(supplierCatalogQuerySchema, query),
      id,
    );
  }
  @Get('supplier-catalog-items')
  items(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.catalog.listItems(
      actor(request),
      parseCatalogInput(supplierCatalogQuerySchema, query),
    );
  }
  @Get('supplier-catalog-items/:id')
  item(@Req() request: AuthenticatedRequest, @Param('id', uuid) id: string) {
    return this.catalog.getItem(actor(request), id);
  }
  @Roles('ADMIN')
  @Post('suppliers/:id/catalog-imports/inspect')
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: supplierCatalogLimits.fileBytes, files: 1, fields: 0, parts: 1 },
    }),
  )
  inspect(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Elegí un archivo .csv o .xlsx de hasta 10 MiB.');
    return this.catalog.inspect(actor(request), id, file);
  }
  @Roles('ADMIN')
  @Post('suppliers/:id/catalog-imports/analyze')
  @HttpCode(200)
  analyze(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.analyze(
      actor(request),
      id,
      parseCatalogInput(catalogAnalysisInputSchema, body),
    );
  }
  @Roles('ADMIN')
  @Get('suppliers/:id/catalog-import-profiles')
  profiles(@Req() request: AuthenticatedRequest, @Param('id', uuid) id: string) {
    return this.catalog.listProfiles(actor(request), id);
  }
  @Roles('ADMIN')
  @Post('suppliers/:id/catalog-import-profiles/reset')
  @HttpCode(200)
  resetProfiles(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    if (!body || typeof body !== 'object' || Object.keys(body).length)
      throw new BadRequestException('No se aceptan campos adicionales.');
    return this.catalog.resetProfiles(actor(request), id);
  }
  @Roles('ADMIN')
  @Post('suppliers/:id/catalog-imports/preview')
  preview(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.preview(
      actor(request),
      id,
      parseCatalogInput(catalogPreviewInputSchema, body),
    );
  }
  @Roles('ADMIN')
  @Post('supplier-catalog-imports/:id/commit')
  @HttpCode(200)
  commit(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.commit(
      actor(request),
      id,
      parseCatalogInput(catalogCommitInputSchema, body),
    );
  }
  @Get('supplier-catalog-imports/:id')
  import(@Req() request: AuthenticatedRequest, @Param('id', uuid) id: string) {
    return this.catalog.getImport(actor(request), id);
  }
  @Get('supplier-catalog-imports/:id/rows')
  rows(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Query() query: unknown,
  ) {
    return this.catalog.rows(
      actor(request),
      id,
      parseCatalogInput(catalogImportRowsQuerySchema, query),
    );
  }
  @Get('suppliers/:id/catalog-imports')
  imports(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Query() query: unknown,
  ) {
    return this.catalog.listImports(
      actor(request),
      id,
      parseCatalogInput(catalogListQuerySchema, query),
    );
  }
}
