-- CreateEnum
CREATE TYPE "PrintTemplateStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "PrintAssetKind" AS ENUM ('BACKGROUND', 'PDF');

-- CreateTable
CREATE TABLE "PrintAsset" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "kind" "PrintAssetKind" NOT NULL,
    "storageKey" VARCHAR(80) NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "widthPx" INTEGER,
    "heightPx" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrintAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrintTemplate" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "familyId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "status" "PrintTemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "pageWidthMm" DECIMAL(9,3) NOT NULL,
    "pageHeightMm" DECIMAL(9,3) NOT NULL,
    "safeToleranceXmm" DECIMAL(7,3) NOT NULL,
    "safeToleranceYmm" DECIMAL(7,3) NOT NULL,
    "backgroundAssetId" UUID NOT NULL,
    "definition" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "publishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "PrintTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrintConfiguration" (
    "organizationId" UUID NOT NULL,
    "templateRevisionId" UUID NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PrintConfiguration_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "PrinterCalibration" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "familyId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "templateRevisionId" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "printerDescription" VARCHAR(160),
    "trayDescription" VARCHAR(160),
    "offsetXmm" DECIMAL(7,3) NOT NULL,
    "offsetYmm" DECIMAL(7,3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PrinterCalibration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrintArtifact" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "deliveryNoteId" UUID NOT NULL,
    "templateRevisionId" UUID NOT NULL,
    "calibrationId" UUID,
    "mode" VARCHAR(20) NOT NULL DEFAULT 'PRINT_OVERLAY',
    "assetId" UUID NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "documentVersion" INTEGER NOT NULL,
    "generatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generatedBy" UUID NOT NULL,
    "generatedByMembershipId" UUID NOT NULL,
    "reprintOfId" UUID,

    CONSTRAINT "PrintArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PrintAsset_storageKey_key" ON "PrintAsset"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "PrintAsset_organizationId_id_key" ON "PrintAsset"("organizationId", "id");

-- CreateIndex
CREATE INDEX "PrintTemplate_organizationId_createdAt_id_idx" ON "PrintTemplate"("organizationId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PrintTemplate_organizationId_id_key" ON "PrintTemplate"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PrintTemplate_organizationId_familyId_revision_key" ON "PrintTemplate"("organizationId", "familyId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "PrinterCalibration_organizationId_id_key" ON "PrinterCalibration"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PrinterCalibration_organizationId_templateRevisionId_id_key" ON "PrinterCalibration"("organizationId", "templateRevisionId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PrinterCalibration_organizationId_familyId_revision_key" ON "PrinterCalibration"("organizationId", "familyId", "revision");

-- CreateIndex
CREATE INDEX "PrintArtifact_organizationId_deliveryNoteId_generatedAt_id_idx" ON "PrintArtifact"("organizationId", "deliveryNoteId", "generatedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PrintArtifact_organizationId_id_key" ON "PrintArtifact"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "PrintAsset" ADD CONSTRAINT "PrintAsset_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrintTemplate" ADD CONSTRAINT "PrintTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrintTemplate" ADD CONSTRAINT "PrintTemplate_organizationId_backgroundAssetId_fkey" FOREIGN KEY ("organizationId", "backgroundAssetId") REFERENCES "PrintAsset"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrintConfiguration" ADD CONSTRAINT "PrintConfiguration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrintConfiguration" ADD CONSTRAINT "PrintConfiguration_organizationId_templateRevisionId_fkey" FOREIGN KEY ("organizationId", "templateRevisionId") REFERENCES "PrintTemplate"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrinterCalibration" ADD CONSTRAINT "PrinterCalibration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrinterCalibration" ADD CONSTRAINT "PrinterCalibration_organizationId_templateRevisionId_fkey" FOREIGN KEY ("organizationId", "templateRevisionId") REFERENCES "PrintTemplate"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrintArtifact" ADD CONSTRAINT "PrintArtifact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrintArtifact" ADD CONSTRAINT "PrintArtifact_organizationId_deliveryNoteId_fkey" FOREIGN KEY ("organizationId", "deliveryNoteId") REFERENCES "DeliveryNote"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrintArtifact" ADD CONSTRAINT "PrintArtifact_organizationId_templateRevisionId_fkey" FOREIGN KEY ("organizationId", "templateRevisionId") REFERENCES "PrintTemplate"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrintArtifact" ADD CONSTRAINT "PrintArtifact_organizationId_templateRevisionId_calibratio_fkey" FOREIGN KEY ("organizationId", "templateRevisionId", "calibrationId") REFERENCES "PrinterCalibration"("organizationId", "templateRevisionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrintArtifact" ADD CONSTRAINT "PrintArtifact_organizationId_assetId_fkey" FOREIGN KEY ("organizationId", "assetId") REFERENCES "PrintAsset"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrintArtifact" ADD CONSTRAINT "PrintArtifact_organizationId_generatedByMembershipId_gener_fkey" FOREIGN KEY ("organizationId", "generatedByMembershipId", "generatedBy") REFERENCES "Membership"("organizationId", "id", "userId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrintArtifact" ADD CONSTRAINT "PrintArtifact_organizationId_reprintOfId_fkey" FOREIGN KEY ("organizationId", "reprintOfId") REFERENCES "PrintArtifact"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Physical geometry belongs only to printing. Existing DeliveryNote/Inventory guards remain intact.
ALTER TABLE "PrintAsset" ADD CONSTRAINT print_asset_valid CHECK (
 "contentHash" ~ '^[a-f0-9]{64}$' AND "byteSize">0 AND
 "storageKey" = "organizationId"::text || '/' || substring("storageKey" from 38) AND
 "storageKey" ~ '^[a-f0-9-]{36}/[a-f0-9-]{36}$' AND
 ((kind='BACKGROUND' AND "widthPx">0 AND "heightPx">0 AND "widthPx"::bigint*"heightPx"<=16000000) OR
 (kind='PDF' AND "widthPx" IS NULL AND "heightPx" IS NULL)));
ALTER TABLE "PrintTemplate" ADD CONSTRAINT print_template_geometry CHECK (
 revision>0 AND "pageWidthMm" BETWEEN 40 AND 1000 AND "pageHeightMm" BETWEEN 40 AND 1000 AND
 "safeToleranceXmm" BETWEEN 0 AND 10 AND "safeToleranceYmm" BETWEEN 0 AND 10 AND
 jsonb_typeof(definition)='object' AND definition->>'schemaVersion'='1' AND
 ((status='DRAFT' AND "publishedAt" IS NULL) OR (status='PUBLISHED' AND "publishedAt" IS NOT NULL)));
ALTER TABLE "PrinterCalibration" ADD CONSTRAINT print_calibration_geometry CHECK (
 revision>0 AND "offsetXmm" BETWEEN -20 AND 20 AND "offsetYmm" BETWEEN -20 AND 20);
ALTER TABLE "PrintArtifact" ADD CONSTRAINT print_artifact_valid CHECK (
 mode='PRINT_OVERLAY' AND "documentVersion">0 AND "contentHash" ~ '^[a-f0-9]{64}$' AND "requestHash" ~ '^[a-f0-9]{64}$');

CREATE FUNCTION maxbio_print_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Print record is immutable; create a new revision or generation' USING ERRCODE='23514'; END $$;
CREATE TRIGGER print_asset_immutable BEFORE UPDATE OR DELETE ON "PrintAsset" FOR EACH ROW EXECUTE FUNCTION maxbio_print_immutable();
CREATE TRIGGER print_calibration_immutable BEFORE UPDATE OR DELETE ON "PrinterCalibration" FOR EACH ROW EXECUTE FUNCTION maxbio_print_immutable();
CREATE TRIGGER print_artifact_immutable BEFORE UPDATE OR DELETE ON "PrintArtifact" FOR EACH ROW EXECUTE FUNCTION maxbio_print_immutable();

CREATE FUNCTION maxbio_print_template_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN
  IF OLD.status='PUBLISHED' OR TG_OP='DELETE' THEN RAISE EXCEPTION 'Template revision is immutable' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(OLD)-'status'-'publishedAt'-'updatedAt') IS DISTINCT FROM (to_jsonb(NEW)-'status'-'publishedAt'-'updatedAt') THEN
   RAISE EXCEPTION 'Create a new template revision' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM "PrintAsset" WHERE id=NEW."backgroundAssetId" AND "organizationId"=NEW."organizationId" AND kind='BACKGROUND') THEN
  RAISE EXCEPTION 'Template needs its private background' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER print_template_guard BEFORE INSERT OR UPDATE OR DELETE ON "PrintTemplate" FOR EACH ROW EXECUTE FUNCTION maxbio_print_template_guard();

CREATE FUNCTION maxbio_print_configuration_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM "PrintTemplate" WHERE id=NEW."templateRevisionId" AND "organizationId"=NEW."organizationId" AND status='PUBLISHED') THEN
  RAISE EXCEPTION 'Only published templates can be active' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER print_configuration_guard BEFORE INSERT OR UPDATE ON "PrintConfiguration" FOR EACH ROW EXECUTE FUNCTION maxbio_print_configuration_guard();

CREATE FUNCTION maxbio_print_artifact_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source "PrintArtifact";
BEGIN
 IF NOT EXISTS (SELECT 1 FROM "DeliveryNote" WHERE id=NEW."deliveryNoteId" AND "organizationId"=NEW."organizationId" AND status='CONFIRMED' AND version=NEW."documentVersion") OR
 NOT EXISTS (SELECT 1 FROM "PrintTemplate" WHERE id=NEW."templateRevisionId" AND "organizationId"=NEW."organizationId" AND status='PUBLISHED') OR
 NOT EXISTS (SELECT 1 FROM "PrintAsset" WHERE id=NEW."assetId" AND "organizationId"=NEW."organizationId" AND kind='PDF' AND "contentHash"=NEW."contentHash") THEN
  RAISE EXCEPTION 'Invalid print generation source' USING ERRCODE='23514'; END IF;
 IF NEW."reprintOfId" IS NOT NULL THEN
  SELECT * INTO source FROM "PrintArtifact" WHERE id=NEW."reprintOfId" AND "organizationId"=NEW."organizationId";
  IF source.id IS NULL OR source."deliveryNoteId"<>NEW."deliveryNoteId" OR source."assetId"<>NEW."assetId" OR
   source."templateRevisionId"<>NEW."templateRevisionId" OR source."calibrationId" IS DISTINCT FROM NEW."calibrationId" OR source."documentVersion"<>NEW."documentVersion" THEN
   RAISE EXCEPTION 'Reprint must preserve the original artifact' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER print_artifact_guard BEFORE INSERT ON "PrintArtifact" FOR EACH ROW EXECUTE FUNCTION maxbio_print_artifact_guard();
