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
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import {
  printTemplateCreateSchema,
  printTemplatePublishSchema,
  printCalibrationCreateSchema,
  printAssetUploadSchema,
  printRenderInputSchema,
  printGenerateInputSchema,
  printTestInputSchema,
  printReprintInputSchema,
} from '@maxbio/contracts';
import type { AuthenticatedRequest } from '../../../common/auth/request-context.js';
import { Roles } from '../../../common/auth/roles.decorator.js';
import { PrintingService } from '../application/printing.service.js';
const uuid = new ParseUUIDPipe({ version: '4' });
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new BadRequestException(
      'Revisá la plantilla, geometría y campos permitidos. ' +
        result.error.issues
          .slice(0, 3)
          .map((i) => i.message)
          .join(' '),
    );
  return result.data;
}
function actor(r: AuthenticatedRequest) {
  if (!r.identity.context) throw new ForbiddenException();
  return r.identity.context;
}
function binary(res: Response, data: Uint8Array, type = 'application/pdf') {
  res.setHeader('Content-Type', type);
  res.setHeader(
    'Content-Disposition',
    'inline; filename="maxbio.' + (type === 'application/pdf' ? 'pdf' : 'png') + '"',
  );
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.send(Buffer.from(data));
}
@Controller('printing')
export class PrintingController {
  constructor(@Inject(PrintingService) private readonly service: PrintingService) {}
  @Get('config') config(@Req() r: AuthenticatedRequest) {
    return this.service.config(actor(r));
  }
  @Get('templates') templates(@Req() r: AuthenticatedRequest) {
    return this.service.listTemplates(actor(r));
  }
  @Post('templates') @HttpCode(200) @Roles('ADMIN') create(
    @Req() r: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    return this.service.createTemplate(actor(r), parse(printTemplateCreateSchema, body));
  }
  @Post('templates/:id/publish') @HttpCode(200) @Roles('ADMIN') publish(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.service.publish(actor(r), id, parse(printTemplatePublishSchema, body).activate);
  }
  @Post('calibrations') @HttpCode(200) @Roles('ADMIN') calibration(
    @Req() r: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    return this.service.createCalibration(actor(r), parse(printCalibrationCreateSchema, body));
  }
  @Post('assets') @HttpCode(200) @Roles('ADMIN') asset(
    @Req() r: AuthenticatedRequest,
    @Body() body: unknown,
  ) {
    return this.service.uploadBackground(actor(r), parse(printAssetUploadSchema, body).pngBase64);
  }
  @Get('assets/:id') async background(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Res() res: Response,
  ) {
    binary(res, await this.service.background(actor(r), id), 'image/png');
  }
  @Post('calibration-test') @HttpCode(200) @Roles('ADMIN') async test(
    @Req() r: AuthenticatedRequest,
    @Body() body: unknown,
    @Res() res: Response,
  ) {
    binary(res, await this.service.testCalibration(actor(r), parse(printTestInputSchema, body)));
  }
  @Post('delivery-notes/:id/evaluate') @HttpCode(200) evaluate(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.service.evaluate(actor(r), id, parse(printRenderInputSchema, body));
  }
  @Post('delivery-notes/:id/preview') @HttpCode(200) async preview(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
    @Res() res: Response,
  ) {
    binary(res, await this.service.preview(actor(r), id, parse(printRenderInputSchema, body)));
  }
  @Post('delivery-notes/:id/artifacts') @HttpCode(200) generate(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.service.generate(actor(r), id, parse(printGenerateInputSchema, body));
  }
  @Get('delivery-notes/:id/artifacts') history(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
  ) {
    return this.service.listArtifacts(actor(r), id);
  }
  @Post('artifacts/:id/reprint') @HttpCode(200) reprint(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Body() body: unknown,
  ) {
    return this.service.reprint(actor(r), id, parse(printReprintInputSchema, body).id);
  }
  @Get('artifacts/:id/pdf') async pdf(
    @Req() r: AuthenticatedRequest,
    @Param('id', uuid) id: string,
    @Res() res: Response,
  ) {
    binary(res, await this.service.artifactPdf(actor(r), id));
  }
}
