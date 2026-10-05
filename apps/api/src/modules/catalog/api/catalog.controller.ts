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
  catalogListQuerySchema,
  productListQuerySchema,
  productCreateSchema,
  productUpdateSchema,
  supplierCreateSchema,
  supplierUpdateSchema,
  namedCreateSchema,
  namedUpdateSchema,
  versionInputSchema,
  identifierMutationSchema,
  identifierLookupQuerySchema,
  supplierProductCreateSchema,
  supplierProductUpdateSchema,
} from '@maxbio/contracts';
import type { AuthenticatedRequest } from '../../../common/auth/request-context.js';
import { Roles } from '../../../common/auth/roles.decorator.js';
import { CatalogService } from '../application/catalog.service.js';

const uuid = new ParseUUIDPipe({ version: '4' });
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const labels: Record<string, string> = {
      name: 'nombre',
      unitOfMeasure: 'unidad de medida',
      brandId: 'marca',
      categoryId: 'categoría',
      supplierId: 'proveedor',
      value: 'identificador',
      kind: 'tipo de identificador',
      expectedVersion: 'información del registro',
      limit: 'tamaño de página (máximo 100)',
      page: 'página',
      email: 'email',
      identifiers: 'identificadores',
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
function actor(request: AuthenticatedRequest) {
  if (!request.identity.context)
    throw new ForbiddenException('Elegí una organización para continuar.');
  return request.identity.context;
}

@Controller()
export class CatalogController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  @Get('products')
  products(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.catalog.listProducts(actor(request), parse(productListQuerySchema, query));
  }
  @Get('products/:id')
  product(@Req() request: AuthenticatedRequest, @Param('id', uuid) id: string) {
    return this.catalog.getProduct(actor(request), id);
  }
  @Roles('ADMIN')
  @Post('products')
  createProduct(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.catalog.createProduct(actor(request), parse(productCreateSchema, body));
  }
  @Roles('ADMIN')
  @Patch('products/:id')
  updateProduct(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.updateProduct(actor(request), id, parse(productUpdateSchema, body));
  }
  @Roles('ADMIN')
  @Post('products/:id/archive')
  @HttpCode(200)
  archiveProduct(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.productState(
      actor(request),
      id,
      parse(versionInputSchema, body).expectedVersion,
      false,
    );
  }
  @Roles('ADMIN')
  @Post('products/:id/restore')
  @HttpCode(200)
  restoreProduct(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.productState(
      actor(request),
      id,
      parse(versionInputSchema, body).expectedVersion,
      true,
    );
  }

  @Get('products/:id/identifiers')
  identifiers(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Query() query: unknown,
  ) {
    return this.catalog.listIdentifiers(actor(request), id, parse(catalogListQuerySchema, query));
  }
  @Get('product-identifiers/resolve')
  resolve(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.catalog.resolveIdentifier(
      actor(request),
      parse(identifierLookupQuerySchema, query),
    );
  }
  @Roles('ADMIN')
  @Post('products/:id/identifiers')
  addIdentifier(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.addIdentifier(actor(request), id, parse(identifierMutationSchema, body));
  }
  @Roles('ADMIN')
  @Post('products/:id/identifiers/:identifierId/archive')
  @HttpCode(200)
  archiveIdentifier(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Param('identifierId', uuid) identifierId: string,
    @Body() body: unknown,
  ) {
    return this.catalog.identifierState(
      actor(request),
      id,
      identifierId,
      parse(versionInputSchema, body).expectedVersion,
      false,
    );
  }
  @Roles('ADMIN')
  @Post('products/:id/identifiers/:identifierId/restore')
  @HttpCode(200)
  restoreIdentifier(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Param('identifierId', uuid) identifierId: string,
    @Body() body: unknown,
  ) {
    return this.catalog.identifierState(
      actor(request),
      id,
      identifierId,
      parse(versionInputSchema, body).expectedVersion,
      true,
    );
  }

  @Get('suppliers')
  suppliers(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.catalog.listSuppliers(actor(request), parse(catalogListQuerySchema, query));
  }
  @Get('suppliers/:id')
  supplier(@Req() request: AuthenticatedRequest, @Param('id', uuid) id: string) {
    return this.catalog.getSupplier(actor(request), id);
  }
  @Roles('ADMIN')
  @Post('suppliers')
  createSupplier(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.catalog.createSupplier(actor(request), parse(supplierCreateSchema, body));
  }
  @Roles('ADMIN')
  @Patch('suppliers/:id')
  updateSupplier(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.updateSupplier(actor(request), id, parse(supplierUpdateSchema, body));
  }
  @Roles('ADMIN')
  @Post('suppliers/:id/archive')
  @HttpCode(200)
  archiveSupplier(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.supplierState(
      actor(request),
      id,
      parse(versionInputSchema, body).expectedVersion,
      false,
    );
  }
  @Roles('ADMIN')
  @Post('suppliers/:id/restore')
  @HttpCode(200)
  restoreSupplier(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.supplierState(
      actor(request),
      id,
      parse(versionInputSchema, body).expectedVersion,
      true,
    );
  }

  @Get('products/:id/supplier-products')
  productLinks(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Query() query: unknown,
  ) {
    return this.catalog.listLinks(
      actor(request),
      { productId: id },
      parse(catalogListQuerySchema, query),
    );
  }
  @Get('suppliers/:id/supplier-products')
  supplierLinks(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Query() query: unknown,
  ) {
    return this.catalog.listLinks(
      actor(request),
      { supplierId: id },
      parse(catalogListQuerySchema, query),
    );
  }
  @Roles('ADMIN')
  @Post('products/:id/supplier-products')
  createLink(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.createLink(actor(request), id, parse(supplierProductCreateSchema, body));
  }
  @Roles('ADMIN')
  @Patch('supplier-products/:id')
  updateLink(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.updateLink(actor(request), id, parse(supplierProductUpdateSchema, body));
  }
  @Roles('ADMIN')
  @Post('supplier-products/:id/archive')
  @HttpCode(200)
  archiveLink(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.linkState(
      actor(request),
      id,
      parse(versionInputSchema, body).expectedVersion,
      false,
    );
  }
  @Roles('ADMIN')
  @Post('supplier-products/:id/restore')
  @HttpCode(200)
  restoreLink(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.linkState(
      actor(request),
      id,
      parse(versionInputSchema, body).expectedVersion,
      true,
    );
  }

  @Get('brands')
  brands(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.catalog.listNamed(actor(request), 'brand', parse(catalogListQuerySchema, query));
  }
  @Roles('ADMIN')
  @Post('brands')
  createBrand(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.catalog.createNamed(actor(request), 'brand', parse(namedCreateSchema, body));
  }
  @Roles('ADMIN')
  @Patch('brands/:id')
  updateBrand(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.updateNamed(actor(request), 'brand', id, parse(namedUpdateSchema, body));
  }
  @Roles('ADMIN')
  @Post('brands/:id/archive')
  @HttpCode(200)
  archiveBrand(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.namedState(
      actor(request),
      'brand',
      id,
      parse(versionInputSchema, body).expectedVersion,
      false,
    );
  }
  @Roles('ADMIN')
  @Post('brands/:id/restore')
  @HttpCode(200)
  restoreBrand(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.namedState(
      actor(request),
      'brand',
      id,
      parse(versionInputSchema, body).expectedVersion,
      true,
    );
  }
  @Get('categories')
  categories(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.catalog.listNamed(actor(request), 'category', parse(catalogListQuerySchema, query));
  }
  @Roles('ADMIN')
  @Post('categories')
  createCategory(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.catalog.createNamed(actor(request), 'category', parse(namedCreateSchema, body));
  }
  @Roles('ADMIN')
  @Patch('categories/:id')
  updateCategory(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.updateNamed(actor(request), 'category', id, parse(namedUpdateSchema, body));
  }
  @Roles('ADMIN')
  @Post('categories/:id/archive')
  @HttpCode(200)
  archiveCategory(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.namedState(
      actor(request),
      'category',
      id,
      parse(versionInputSchema, body).expectedVersion,
      false,
    );
  }
  @Roles('ADMIN')
  @Post('categories/:id/restore')
  @HttpCode(200)
  restoreCategory(
    @Req() request: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.namedState(
      actor(request),
      'category',
      id,
      parse(versionInputSchema, body).expectedVersion,
      true,
    );
  }
}
