import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import type { Prisma } from '@maxbio/database';
import {
  printTemplateSchema,
  printCalibrationSchema,
  printArtifactSchema,
  printTemplateCreateSchema,
  type PrintTemplateCreate,
  type PrintCalibrationCreate,
  type PrintRenderInput,
  type PrintGenerateInput,
  type DeliveryNoteView,
} from '@maxbio/contracts';
import { DatabaseService } from '../../../infrastructure/database/database.service.js';
import type { RequestActorContext } from '../../../common/auth/request-context.js';
import { AuditService } from '../../audit/audit.service.js';
import {
  deliveryNoteInclude,
  deliveryNoteView,
} from '../../delivery-notes/application/delivery-note-view.js';
import {
  PRINT_STORAGE,
  type PrivatePrintStorage,
} from '../infrastructure/private-print-storage.js';
import { evaluatePrint, renderPdf, renderCalibrationTest } from '../infrastructure/pdf-renderer.js';

type Tx = Prisma.TransactionClient;
type TemplateRow = Prisma.PrintTemplateGetPayload<object>;
type CalibrationRow = Prisma.PrinterCalibrationGetPayload<object>;
function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (typeof v === 'object' && v !== null)
    return (
      '{' +
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, value]) => JSON.stringify(k) + ':' + canonical(value))
        .join(',') +
      '}'
    );
  return JSON.stringify(v);
}
const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const bytesHash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
function templateView(t: TemplateRow) {
  return printTemplateSchema.parse({
    id: t.id,
    familyId: t.familyId,
    revision: t.revision,
    name: t.name,
    status: t.status,
    pageWidthMm: Number(t.pageWidthMm),
    pageHeightMm: Number(t.pageHeightMm),
    safeToleranceXmm: Number(t.safeToleranceXmm),
    safeToleranceYmm: Number(t.safeToleranceYmm),
    backgroundAssetId: t.backgroundAssetId,
    definition: t.definition,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    publishedAt: t.publishedAt?.toISOString() ?? null,
  });
}
function calibrationView(c: CalibrationRow) {
  return printCalibrationSchema.parse({
    id: c.id,
    familyId: c.familyId,
    revision: c.revision,
    templateRevisionId: c.templateRevisionId,
    name: c.name,
    printerDescription: c.printerDescription,
    trayDescription: c.trayDescription,
    offsetXmm: Number(c.offsetXmm),
    offsetYmm: Number(c.offsetYmm),
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  });
}
function artifactView(a: Prisma.PrintArtifactGetPayload<object>) {
  return printArtifactSchema.parse({
    id: a.id,
    deliveryNoteId: a.deliveryNoteId,
    templateRevisionId: a.templateRevisionId,
    calibrationId: a.calibrationId,
    mode: a.mode,
    contentHash: a.contentHash,
    documentVersion: a.documentVersion,
    generatedAt: a.generatedAt.toISOString(),
    generatedBy: a.generatedBy,
    reprintOfId: a.reprintOfId,
  });
}

@Injectable()
export class PrintingService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PRINT_STORAGE) private readonly storage: PrivatePrintStorage,
  ) {}

  private async authorize(tx: Tx, c: RequestActorContext, admin = false) {
    if (!['ADMIN', 'OPERATOR'].includes(c.role) || (admin && c.role !== 'ADMIN'))
      throw new ForbiddenException();
    const now = new Date();
    const member = await tx.membership.findFirst({
      where: {
        id: c.membershipId,
        organizationId: c.organizationId,
        userId: c.userId,
        role: c.role,
        revokedAt: null,
        user: { disabledAt: null },
        organization: { archivedAt: null },
      },
    });
    const session = await tx.session.findFirst({
      where: {
        id: c.sessionId,
        userId: c.userId,
        activeMembershipId: c.membershipId,
        revokedAt: null,
        expiresAt: { gt: now },
        absoluteExpiresAt: { gt: now },
      },
    });
    if (!member || !session)
      throw new ForbiddenException('Tu acceso cambió. Volvé a iniciar sesión.');
  }
  private write<T>(c: RequestActorContext, fn: (tx: Tx) => Promise<T>, admin = false) {
    return this.db.client.$transaction(
      async (tx) => {
        await this.authorize(tx, c, admin);
        return fn(tx);
      },
      { timeout: 10000, maxWait: 5000 },
    );
  }
  private async lock(tx: Tx, key: string) {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${key},0))`;
  }
  private async template(tx: Tx, c: RequestActorContext, id: string, published = true) {
    const row = await tx.printTemplate.findFirst({
      where: { organizationId: c.organizationId, id },
    });
    if (!row) throw new NotFoundException();
    if (published && row.status !== 'PUBLISHED')
      throw new ConflictException('La plantilla todavía no está publicada.');
    return templateView(row);
  }
  private async calibration(tx: Tx, c: RequestActorContext, templateId: string, id: string | null) {
    if (!id) return null;
    const row = await tx.printerCalibration.findFirst({
      where: { organizationId: c.organizationId, id, templateRevisionId: templateId },
    });
    if (!row)
      throw new NotFoundException('No encontramos una calibración compatible con esta revisión.');
    return calibrationView(row);
  }
  private async document(tx: Tx, c: RequestActorContext, id: string) {
    const d = await tx.deliveryNote.findFirst({
      where: { organizationId: c.organizationId, id },
      include: deliveryNoteInclude,
    });
    if (!d) throw new NotFoundException();
    if (d.status === 'CANCELLED') throw new ConflictException('No se imprime un remito cancelado.');
    return deliveryNoteView(d);
  }
  async config(c: RequestActorContext) {
    return this.db.client.$transaction(
      async (tx) => {
        const config = await tx.printConfiguration.findUnique({
          where: { organizationId: c.organizationId },
          include: { template: true },
        });
        const calibrations = await tx.printerCalibration.findMany({
          where: { organizationId: c.organizationId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 100,
        });
        return {
          activeTemplate: config ? templateView(config.template) : null,
          calibrations: calibrations.map(calibrationView),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  async listTemplates(c: RequestActorContext) {
    return {
      items: (
        await this.db.client.printTemplate.findMany({
          where: { organizationId: c.organizationId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 100,
        })
      ).map(templateView),
    };
  }
  async uploadBackground(c: RequestActorContext, encoded: string) {
    if (c.role !== 'ADMIN') throw new ForbiddenException();
    const input = Buffer.from(encoded, 'base64');
    // Check dimensions before decompression. Re-encoding strips ancillary/private metadata.
    if (
      input.length > 4194304 ||
      input.length < 24 ||
      !input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      input.toString('ascii', 12, 16) !== 'IHDR'
    )
      throw new BadRequestException('Usá un PNG válido de hasta 4 MiB.');
    const width = input.readUInt32BE(16),
      height = input.readUInt32BE(20);
    if (!width || !height || width > 8000 || height > 8000 || width * height > 16000000)
      throw new BadRequestException('El PNG supera las dimensiones permitidas (16 megapíxeles).');
    let bytes: Buffer;
    try {
      bytes = PNG.sync.write(PNG.sync.read(input, { checkCRC: true }));
    } catch {
      throw new BadRequestException('No pudimos leer el PNG. Prepará otra imagen de referencia.');
    }
    if (bytes.length > 4194304)
      throw new BadRequestException(
        'El PNG normalizado supera 4 MiB. Prepará un fondo más liviano.',
      );
    const key = await this.storage.put(c.organizationId, bytes),
      id = randomUUID(),
      contentHash = bytesHash(bytes);
    try {
      return await this.write(
        c,
        async (tx) => {
          await tx.printAsset.create({
            data: {
              id,
              organizationId: c.organizationId,
              kind: 'BACKGROUND',
              storageKey: key,
              contentHash,
              byteSize: bytes.length,
              widthPx: width,
              heightPx: height,
            },
          });
          return { id, contentHash };
        },
        true,
      );
    } catch (e) {
      await this.storage.remove(key);
      throw e;
    }
  }
  async background(c: RequestActorContext, id: string) {
    const a = await this.db.client.printAsset.findFirst({
      where: { organizationId: c.organizationId, id, kind: 'BACKGROUND' },
    });
    if (!a) throw new NotFoundException();
    return this.readAsset(a);
  }
  private async readAsset(a: { storageKey: string; contentHash: string }) {
    const bytes = await this.storage.read(a.storageKey);
    if (bytesHash(bytes) !== a.contentHash)
      throw new ConflictException('El archivo privado no coincide con su huella registrada.');
    return bytes;
  }
  async createTemplate(c: RequestActorContext, input: PrintTemplateCreate) {
    return this.write(
      c,
      async (tx) => {
        await this.lock(tx, `print-revisions:${c.organizationId}`);
        if (await tx.printTemplate.findUnique({ where: { id: input.id } }))
          throw new ConflictException('Ese identificador de revisión ya existe. Recargá la lista.');
        const source = input.sourceTemplateId
          ? await this.template(tx, c, input.sourceTemplateId, false)
          : null;
        const asset = await tx.printAsset.findFirst({
          where: {
            organizationId: c.organizationId,
            id: input.backgroundAssetId,
            kind: 'BACKGROUND',
          },
        });
        if (!asset) throw new NotFoundException();
        if (
          Math.abs(
            asset.widthPx! / asset.heightPx! / (input.pageWidthMm / input.pageHeightMm) - 1,
          ) > 0.01
        )
          throw new BadRequestException(
            'La proporción del PNG no coincide con el tamaño físico. Prepará el fondo sin deformarlo.',
          );
        const familyId = source?.familyId ?? input.id;
        const last = await tx.printTemplate.aggregate({
          where: { organizationId: c.organizationId, familyId },
          _max: { revision: true },
        });
        const { sourceTemplateId: _source, ...fields } = input;
        void _source;
        const row = await tx.printTemplate.create({
          data: {
            ...fields,
            definition: fields.definition as Prisma.InputJsonValue,
            organizationId: c.organizationId,
            familyId,
            revision: (last._max.revision ?? 0) + 1,
          },
        });
        await this.audit.success(c, 'PRINT_TEMPLATE_CREATED', 'PrintTemplate', row.id, tx);
        return templateView(row);
      },
      true,
    );
  }
  async publish(c: RequestActorContext, id: string, activate: boolean) {
    return this.write(
      c,
      async (tx) => {
        await this.lock(tx, `print-config:${c.organizationId}`);
        const row = await this.template(tx, c, id, false);
        // Validate persisted geometry as well as the create contract.
        printTemplateCreateSchema.parse({
          id: row.id,
          name: row.name,
          pageWidthMm: row.pageWidthMm,
          pageHeightMm: row.pageHeightMm,
          safeToleranceXmm: row.safeToleranceXmm,
          safeToleranceYmm: row.safeToleranceYmm,
          backgroundAssetId: row.backgroundAssetId,
          definition: row.definition,
        });
        let result = row;
        if (row.status !== 'PUBLISHED') {
          result = templateView(
            await tx.printTemplate.update({
              where: { id },
              data: { status: 'PUBLISHED', publishedAt: new Date() },
            }),
          );
          await this.audit.success(c, 'PRINT_TEMPLATE_PUBLISHED', 'PrintTemplate', id, tx);
        }
        if (activate) {
          const old = await tx.printConfiguration.findUnique({
            where: { organizationId: c.organizationId },
          });
          if (old?.templateRevisionId !== id) {
            await tx.printConfiguration.upsert({
              where: { organizationId: c.organizationId },
              create: { organizationId: c.organizationId, templateRevisionId: id },
              update: { templateRevisionId: id },
            });
            await this.audit.success(c, 'PRINT_TEMPLATE_ACTIVATED', 'PrintTemplate', id, tx);
          }
        }
        return result;
      },
      true,
    );
  }
  async createCalibration(c: RequestActorContext, input: PrintCalibrationCreate) {
    return this.write(
      c,
      async (tx) => {
        await this.lock(tx, `print-calibrations:${c.organizationId}`);
        await this.template(tx, c, input.templateRevisionId);
        if (await tx.printerCalibration.findUnique({ where: { id: input.id } }))
          throw new ConflictException('Esa calibración ya existe. Recargá la configuración.');
        const source = input.sourceCalibrationId
          ? await this.calibration(tx, c, input.templateRevisionId, input.sourceCalibrationId)
          : null;
        const familyId = source?.familyId ?? input.id;
        const last = await tx.printerCalibration.aggregate({
          where: { organizationId: c.organizationId, familyId },
          _max: { revision: true },
        });
        const { sourceCalibrationId: _source, ...fields } = input;
        void _source;
        const row = await tx.printerCalibration.create({
          data: {
            ...fields,
            organizationId: c.organizationId,
            familyId,
            revision: (last._max.revision ?? 0) + 1,
          },
        });
        await this.audit.success(c, 'PRINT_CALIBRATION_UPDATED', 'PrinterCalibration', row.id, tx);
        return calibrationView(row);
      },
      true,
    );
  }
  private async context(
    c: RequestActorContext,
    id: string,
    input: PrintRenderInput,
    published = true,
  ) {
    return this.db.client.$transaction(
      async (tx) => {
        const document = await this.document(tx, c, id);
        if (document.version !== input.expectedVersion)
          throw new ConflictException('El remito cambió. Guardá o recargá antes de previsualizar.');
        const template = await this.template(tx, c, input.templateRevisionId, published);
        if (!published && template.status === 'DRAFT' && c.role !== 'ADMIN')
          throw new ForbiddenException();
        const calibration = await this.calibration(tx, c, template.id, input.calibrationId);
        return { document, template, calibration };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  async evaluate(c: RequestActorContext, id: string, input: PrintRenderInput) {
    const context = await this.context(c, id, input, false);
    return (await evaluatePrint(context.document, context.template, context.calibration))
      .evaluation;
  }
  async preview(c: RequestActorContext, id: string, input: PrintRenderInput) {
    const context = await this.context(c, id, input, false);
    const background = await this.background(c, context.template.backgroundAssetId);
    return (await renderPdf({ ...context, mode: 'PREVIEW', background, guides: input.guides }))
      .bytes;
  }
  async testCalibration(
    c: RequestActorContext,
    input: { templateRevisionId: string; calibrationId: string | null },
  ) {
    return this.write(
      c,
      async (tx) =>
        renderCalibrationTest(
          await this.template(tx, c, input.templateRevisionId, false),
          await this.calibration(tx, c, input.templateRevisionId, input.calibrationId),
        ),
      true,
    );
  }
  /** Read-only geometry guard inside the existing confirmation transaction. Never renders or touches files. */
  async assertConfirmable(tx: Tx, c: RequestActorContext, document: DeliveryNoteView) {
    await this.lock(tx, `print-config:${c.organizationId}`);
    const config = await tx.printConfiguration.findUnique({
      where: { organizationId: c.organizationId },
      include: { template: true },
    });
    if (!config) return;
    const result = (await evaluatePrint(document, templateView(config.template), null)).evaluation;
    if (result.state === 'BLOCKED')
      throw new ConflictException(
        'El remito no entra en la plantilla activa: ' +
          result.issues.find((i) => i.state === 'BLOCKED')!.message,
      );
  }
  async generate(c: RequestActorContext, id: string, input: PrintGenerateInput) {
    const requestHash = digest({ kind: 'GENERATE', id, input, actor: c.userId });
    const prior = await this.db.client.printArtifact.findFirst({
      where: { organizationId: c.organizationId, id: input.id },
    });
    if (prior) {
      if (prior.requestHash !== requestHash)
        throw new ConflictException('Este intento ya fue utilizado con otros datos.');
      return artifactView(prior);
    }
    const context = await this.context(c, id, { ...input, guides: false });
    if (context.document.status !== 'CONFIRMED')
      throw new ConflictException('Confirmá la salida antes de generar el overlay definitivo.');
    const layout = await evaluatePrint(context.document, context.template, context.calibration);
    if (layout.evaluation.state === 'BLOCKED')
      throw new ConflictException(
        layout.evaluation.issues.find((i) => i.state === 'BLOCKED')!.message,
      );
    const pdf = await renderPdf({ ...context, mode: 'PRINT_OVERLAY' });
    const key = await this.storage.put(c.organizationId, pdf.bytes);
    let used = false;
    try {
      return await this.write(c, async (tx) => {
        await this.lock(tx, `print-artifact:${input.id}`);
        const replay = await tx.printArtifact.findUnique({ where: { id: input.id } });
        if (replay) {
          if (replay.organizationId !== c.organizationId) throw new NotFoundException();
          if (replay.requestHash !== requestHash)
            throw new ConflictException('Este intento ya fue utilizado con otros datos.');
          return artifactView(replay);
        }
        const asset = await tx.printAsset.create({
          data: {
            organizationId: c.organizationId,
            kind: 'PDF',
            storageKey: key,
            byteSize: pdf.bytes.length,
            contentHash: bytesHash(pdf.bytes),
          },
        });
        const row = await tx.printArtifact.create({
          data: {
            id: input.id,
            organizationId: c.organizationId,
            deliveryNoteId: id,
            templateRevisionId: context.template.id,
            calibrationId: context.calibration?.id ?? null,
            assetId: asset.id,
            contentHash: asset.contentHash,
            requestHash,
            documentVersion: context.document.version,
            generatedBy: c.userId,
            generatedByMembershipId: c.membershipId,
          },
        });
        await this.audit.success(
          c,
          'DELIVERY_NOTE_PRINT_ARTIFACT_GENERATED',
          'PrintArtifact',
          row.id,
          tx,
        );
        used = true;
        return artifactView(row);
      });
    } catch (e) {
      used = false;
      throw e;
    } finally {
      if (!used) await this.storage.remove(key);
    }
  }
  async reprint(c: RequestActorContext, artifactId: string, id: string) {
    return this.write(c, async (tx) => {
      await this.lock(tx, `print-artifact:${id}`);
      const source = await tx.printArtifact.findFirst({
        where: { organizationId: c.organizationId, id: artifactId },
        include: { asset: true },
      });
      if (!source) throw new NotFoundException();
      const requestHash = digest({ kind: 'REPRINT', artifactId, id, actor: c.userId });
      const replay = await tx.printArtifact.findUnique({ where: { id } });
      if (replay) {
        if (replay.organizationId !== c.organizationId) throw new NotFoundException();
        if (replay.requestHash !== requestHash)
          throw new ConflictException('Este intento ya fue utilizado con otros datos.');
        return artifactView(replay);
      }
      // Verify availability/integrity before recording another generation. Exact stored bytes, no rerender.
      await this.readAsset(source.asset);
      const row = await tx.printArtifact.create({
        data: {
          id,
          organizationId: c.organizationId,
          deliveryNoteId: source.deliveryNoteId,
          templateRevisionId: source.templateRevisionId,
          calibrationId: source.calibrationId,
          assetId: source.assetId,
          contentHash: source.contentHash,
          requestHash,
          documentVersion: source.documentVersion,
          generatedBy: c.userId,
          generatedByMembershipId: c.membershipId,
          reprintOfId: source.id,
        },
      });
      await this.audit.success(
        c,
        'DELIVERY_NOTE_PRINT_ARTIFACT_GENERATED',
        'PrintArtifact',
        id,
        tx,
      );
      return artifactView(row);
    });
  }
  async listArtifacts(c: RequestActorContext, id: string) {
    if (
      !(await this.db.client.deliveryNote.findFirst({
        where: { organizationId: c.organizationId, id },
      }))
    )
      throw new NotFoundException();
    return {
      items: (
        await this.db.client.printArtifact.findMany({
          where: { organizationId: c.organizationId, deliveryNoteId: id },
          orderBy: [{ generatedAt: 'desc' }, { id: 'desc' }],
          take: 100,
        })
      ).map(artifactView),
    };
  }
  async artifactPdf(c: RequestActorContext, id: string) {
    const row = await this.db.client.printArtifact.findFirst({
      where: { organizationId: c.organizationId, id },
      include: { asset: true },
    });
    if (!row) throw new NotFoundException();
    return this.readAsset(row.asset);
  }
}
