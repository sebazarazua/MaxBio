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
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import {
  arcaActivateSchema,
  arcaCertificateSchema,
  arcaGenerateSchema,
  arcaDiscardSchema,
  arcaTestSchema,
  fiscalProfileUpdateSchema,
  wsfeSelectPointSchema,
} from '@maxbio/contracts';
import type { AuthenticatedRequest } from '../../../common/auth/request-context.js';
import { Roles } from '../../../common/auth/roles.decorator.js';
import { FiscalService } from '../application/fiscal.service.js';
import { WsfeConfigurationService } from '../application/wsfe-configuration.service.js';
const uuid = new ParseUUIDPipe({ version: '4' });
function parse<T>(schema: z.ZodType<T>, body: unknown) {
  const result = schema.safeParse(body);
  if (!result.success)
    throw new BadRequestException(
      'Revisá los datos fiscales, el CUIT y el archivo. No se aceptan campos adicionales.',
    );
  return result.data;
}
const emptyQuery = (q: unknown) => parse(z.object({}).strict(), q);
function actor(r: AuthenticatedRequest) {
  if (!r.identity.context) throw new ForbiddenException();
  return r.identity.context;
}
@Controller('fiscal')
@Roles('ADMIN')
export class FiscalController {
  constructor(
    @Inject(FiscalService) private readonly service: FiscalService,
    @Inject(WsfeConfigurationService) private readonly invoicing: WsfeConfigurationService,
  ) {}
  @Get('arca/invoicing') configuration(@Req() r: AuthenticatedRequest, @Query() q: unknown) {
    emptyQuery(q);
    return this.invoicing.get(actor(r));
  }
  @Post('arca/invoicing/refresh') @HttpCode(200) refreshReferences(
    @Req() r: AuthenticatedRequest,
    @Query() q: unknown,
    @Body() b: unknown,
  ) {
    emptyQuery(q);
    parse(arcaTestSchema, b);
    return this.invoicing.refresh(actor(r));
  }
  @Post('arca/invoicing/point-of-sale') @HttpCode(200) selectPoint(
    @Req() r: AuthenticatedRequest,
    @Query() q: unknown,
    @Body() b: unknown,
  ) {
    emptyQuery(q);
    return this.invoicing.selectPoint(actor(r), parse(wsfeSelectPointSchema, b));
  }
  @Get('profile') profile(@Req() r: AuthenticatedRequest, @Query() q: unknown) {
    emptyQuery(q);
    return this.service.getProfile(actor(r));
  }
  @Put('profile') update(@Req() r: AuthenticatedRequest, @Body() b: unknown, @Query() q: unknown) {
    emptyQuery(q);
    return this.service.updateProfile(actor(r), parse(fiscalProfileUpdateSchema, b));
  }
  @Get('arca/readiness') readiness(@Req() r: AuthenticatedRequest, @Query() q: unknown) {
    emptyQuery(q);
    return this.service.readiness(actor(r));
  }
  @Post('arca/credentials/generate') @HttpCode(200) generate(
    @Req() r: AuthenticatedRequest,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    emptyQuery(q);
    return this.service.generate(actor(r), parse(arcaGenerateSchema, b));
  }
  @Get('arca/credentials/:id/csr') csr(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Query() q: unknown,
  ) {
    emptyQuery(q);
    return this.service.csr(actor(r), id);
  }
  @Post('arca/credentials/:id/certificate') @HttpCode(200) certificate(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    emptyQuery(q);
    return this.service.install(actor(r), id, parse(arcaCertificateSchema, b));
  }
  @Post('arca/credentials/:id/activate') @HttpCode(200) activate(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    emptyQuery(q);
    return this.service.activate(actor(r), id, parse(arcaActivateSchema, b));
  }
  @Post('arca/credentials/:id/discard') @HttpCode(200) discard(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    emptyQuery(q);
    return this.service.discard(actor(r), id, parse(arcaDiscardSchema, b));
  }
  @Post('arca/credentials/:id/cleanup') @HttpCode(200) cleanup(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    emptyQuery(q);
    parse(arcaTestSchema, b);
    return this.service.cleanupRetired(actor(r), id);
  }
  @Post('arca/wsaa/test') @HttpCode(200) test(
    @Req() r: AuthenticatedRequest,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    emptyQuery(q);
    parse(arcaTestSchema, b);
    return this.service.testConnection(actor(r));
  }
}
