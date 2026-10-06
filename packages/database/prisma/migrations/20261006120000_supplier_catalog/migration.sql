-- CreateEnum
CREATE TYPE "SupplierCatalogImportMode" AS ENUM ('PARTIAL', 'COMPLETE');

-- CreateEnum
CREATE TYPE "SupplierCatalogImportStatus" AS ENUM ('PREVIEW', 'COMMITTED');

-- CreateEnum
CREATE TYPE "SupplierCatalogRowOutcome" AS ENUM ('CREATED', 'UPDATED', 'UNCHANGED', 'DUPLICATE', 'EMPTY', 'ERROR', 'CONFLICT');

-- CreateTable
CREATE TABLE "SupplierCatalogItem" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "supplierCode" VARCHAR(128) NOT NULL,
    "description" VARCHAR(1000) NOT NULL,
    "brandText" VARCHAR(160),
    "presentationText" VARCHAR(200),
    "reportedGtin" VARCHAR(128),
    "normalizedReportedGtin" VARCHAR(14),
    "missingFromLatestCompleteListAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "SupplierCatalogItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierCatalogUpload" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "fileName" VARCHAR(200) NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "format" VARCHAR(4) NOT NULL,
    "sheets" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SupplierCatalogUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierCatalogImport" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "fileName" VARCHAR(200) NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "format" VARCHAR(4) NOT NULL,
    "sheetName" VARCHAR(31) NOT NULL,
    "headerRow" INTEGER NOT NULL,
    "mapping" JSONB NOT NULL,
    "mode" "SupplierCatalogImportMode" NOT NULL,
    "status" "SupplierCatalogImportStatus" NOT NULL DEFAULT 'PREVIEW',
    "previewHash" CHAR(64) NOT NULL,
    "catalogHash" CHAR(64) NOT NULL,
    "summary" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "committedAt" TIMESTAMPTZ(3),
    "excludedInvalidRows" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SupplierCatalogImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierCatalogImportRow" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "importId" UUID NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "outcome" "SupplierCatalogRowOutcome" NOT NULL,
    "itemId" UUID,
    "supplierCode" VARCHAR(128),
    "data" JSONB,
    "messages" JSONB NOT NULL,

    CONSTRAINT "SupplierCatalogImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierCatalogItem_organizationId_supplierId_archivedAt_su_idx" ON "SupplierCatalogItem"("organizationId", "supplierId", "archivedAt", "supplierCode", "id");

-- CreateIndex
CREATE INDEX "SupplierCatalogItem_organizationId_normalizedReportedGtin_idx" ON "SupplierCatalogItem"("organizationId", "normalizedReportedGtin");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierCatalogItem_organizationId_supplierId_supplierCode_key" ON "SupplierCatalogItem"("organizationId", "supplierId", "supplierCode");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierCatalogItem_organizationId_supplierId_id_key" ON "SupplierCatalogItem"("organizationId", "supplierId", "id");

-- CreateIndex
CREATE INDEX "SupplierCatalogUpload_organizationId_actorUserId_expiresAt_idx" ON "SupplierCatalogUpload"("organizationId", "actorUserId", "expiresAt");

-- CreateIndex
CREATE INDEX "SupplierCatalogUpload_expiresAt_idx" ON "SupplierCatalogUpload"("expiresAt");

-- CreateIndex
CREATE INDEX "SupplierCatalogImport_organizationId_supplierId_createdAt_i_idx" ON "SupplierCatalogImport"("organizationId", "supplierId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "SupplierCatalogImport_organizationId_status_expiresAt_idx" ON "SupplierCatalogImport"("organizationId", "status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierCatalogImport_organizationId_supplierId_id_key" ON "SupplierCatalogImport"("organizationId", "supplierId", "id");

-- CreateIndex
CREATE INDEX "SupplierCatalogImportRow_organizationId_importId_outcome_ro_idx" ON "SupplierCatalogImportRow"("organizationId", "importId", "outcome", "rowNumber");

-- CreateIndex
CREATE INDEX "SupplierCatalogImportRow_organizationId_supplierId_itemId_idx" ON "SupplierCatalogImportRow"("organizationId", "supplierId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierCatalogImportRow_organizationId_importId_rowNumber_key" ON "SupplierCatalogImportRow"("organizationId", "importId", "rowNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_organizationId_id_userId_key" ON "Membership"("organizationId", "id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_id_userId_key" ON "Session"("id", "userId");

-- AddForeignKey
ALTER TABLE "SupplierCatalogItem" ADD CONSTRAINT "SupplierCatalogItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierCatalogItem" ADD CONSTRAINT "SupplierCatalogItem_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierCatalogUpload" ADD CONSTRAINT "SupplierCatalogUpload_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierCatalogUpload" ADD CONSTRAINT "SupplierCatalogUpload_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierCatalogUpload" ADD CONSTRAINT "SupplierCatalogUpload_organizationId_membershipId_actorUse_fkey" FOREIGN KEY ("organizationId", "membershipId", "actorUserId") REFERENCES "Membership"("organizationId", "id", "userId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierCatalogUpload" ADD CONSTRAINT "SupplierCatalogUpload_sessionId_actorUserId_fkey" FOREIGN KEY ("sessionId", "actorUserId") REFERENCES "Session"("id", "userId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierCatalogImport" ADD CONSTRAINT "SupplierCatalogImport_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierCatalogImport" ADD CONSTRAINT "SupplierCatalogImport_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierCatalogImport" ADD CONSTRAINT "SupplierCatalogImport_organizationId_membershipId_actorUse_fkey" FOREIGN KEY ("organizationId", "membershipId", "actorUserId") REFERENCES "Membership"("organizationId", "id", "userId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierCatalogImport" ADD CONSTRAINT "SupplierCatalogImport_sessionId_actorUserId_fkey" FOREIGN KEY ("sessionId", "actorUserId") REFERENCES "Session"("id", "userId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierCatalogImportRow" ADD CONSTRAINT "SupplierCatalogImportRow_organizationId_supplierId_importI_fkey" FOREIGN KEY ("organizationId", "supplierId", "importId") REFERENCES "SupplierCatalogImport"("organizationId", "supplierId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierCatalogImportRow" ADD CONSTRAINT "SupplierCatalogImportRow_organizationId_supplierId_itemId_fkey" FOREIGN KEY ("organizationId", "supplierId", "itemId") REFERENCES "SupplierCatalogItem"("organizationId", "supplierId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Invariantes comerciales y límites que Prisma no expresa.
ALTER TABLE "SupplierCatalogItem"
  ADD CONSTRAINT "SupplierCatalogItem_code_check" CHECK (length("supplierCode") > 0 AND "supplierCode" = btrim("supplierCode") AND "supplierCode" !~ '[[:cntrl:]]'),
  ADD CONSTRAINT "SupplierCatalogItem_description_check" CHECK (length(btrim("description")) > 0 AND "description" !~ '[[:cntrl:]]'),
  ADD CONSTRAINT "SupplierCatalogItem_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "SupplierCatalogItem_gtin_check" CHECK ("normalizedReportedGtin" IS NULL OR ("reportedGtin" IS NOT NULL AND maxbio_valid_gtin("reportedGtin") AND "normalizedReportedGtin" = lpad("reportedGtin",14,'0')));
ALTER TABLE "SupplierCatalogUpload"
  ADD CONSTRAINT "SupplierCatalogUpload_format_check" CHECK ("format" IN ('CSV','XLSX')),
  ADD CONSTRAINT "SupplierCatalogUpload_hash_check" CHECK ("contentHash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "SupplierCatalogUpload_expiry_check" CHECK ("expiresAt" > "createdAt" AND jsonb_typeof("sheets") = 'array');
ALTER TABLE "SupplierCatalogImport"
  ADD CONSTRAINT "SupplierCatalogImport_format_check" CHECK ("format" IN ('CSV','XLSX')),
  ADD CONSTRAINT "SupplierCatalogImport_hash_check" CHECK ("contentHash" ~ '^[a-f0-9]{64}$' AND "previewHash" ~ '^[a-f0-9]{64}$' AND "catalogHash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "SupplierCatalogImport_header_check" CHECK ("headerRow" BETWEEN 1 AND 20 AND length("sheetName") > 0),
  ADD CONSTRAINT "SupplierCatalogImport_status_check" CHECK (("status" = 'PREVIEW' AND "committedAt" IS NULL) OR ("status" = 'COMMITTED' AND "committedAt" IS NOT NULL)),
  ADD CONSTRAINT "SupplierCatalogImport_json_check" CHECK (jsonb_typeof("mapping") = 'object' AND jsonb_typeof("summary") = 'object');
ALTER TABLE "SupplierCatalogImportRow"
  ADD CONSTRAINT "SupplierCatalogImportRow_number_check" CHECK ("rowNumber" BETWEEN 2 AND 10020),
  ADD CONSTRAINT "SupplierCatalogImportRow_json_check" CHECK (jsonb_typeof("messages") = 'array' AND ("data" IS NULL OR jsonb_typeof("data") = 'object'));
