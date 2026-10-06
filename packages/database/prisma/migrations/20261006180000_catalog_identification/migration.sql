-- AlterTable
ALTER TABLE "SupplierCatalogItem" ADD COLUMN     "supplierProductId" UUID;

-- CreateTable
CREATE TABLE "SupplierScanIdentifier" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "supplierProductId" UUID NOT NULL,
    "value" VARCHAR(128) NOT NULL,
    "normalizedValue" VARCHAR(128) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "SupplierScanIdentifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogIdentification" (
    "id" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "supplierId" UUID NOT NULL,
    "referenceId" UUID NOT NULL,
    "supplierProductId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogIdentification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierScanIdentifier_organizationId_supplierId_supplierPr_idx" ON "SupplierScanIdentifier"("organizationId", "supplierId", "supplierProductId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierScanIdentifier_organizationId_supplierId_normalized_key" ON "SupplierScanIdentifier"("organizationId", "supplierId", "normalizedValue");

-- CreateIndex
CREATE INDEX "CatalogIdentification_organizationId_supplierId_referenceId_idx" ON "CatalogIdentification"("organizationId", "supplierId", "referenceId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogIdentification_organizationId_operationId_key" ON "CatalogIdentification"("organizationId", "operationId");

-- CreateIndex
CREATE INDEX "SupplierCatalogItem_organizationId_supplierId_supplierProdu_idx" ON "SupplierCatalogItem"("organizationId", "supplierId", "supplierProductId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierProduct_organizationId_supplierId_id_key" ON "SupplierProduct"("organizationId", "supplierId", "id");

-- AddForeignKey
ALTER TABLE "SupplierCatalogItem" ADD CONSTRAINT "SupplierCatalogItem_organizationId_supplierId_supplierProd_fkey" FOREIGN KEY ("organizationId", "supplierId", "supplierProductId") REFERENCES "SupplierProduct"("organizationId", "supplierId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierScanIdentifier" ADD CONSTRAINT "SupplierScanIdentifier_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierScanIdentifier" ADD CONSTRAINT "SupplierScanIdentifier_organizationId_supplierId_supplierP_fkey" FOREIGN KEY ("organizationId", "supplierId", "supplierProductId") REFERENCES "SupplierProduct"("organizationId", "supplierId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CatalogIdentification" ADD CONSTRAINT "CatalogIdentification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CatalogIdentification" ADD CONSTRAINT "CatalogIdentification_organizationId_membershipId_actorUse_fkey" FOREIGN KEY ("organizationId", "membershipId", "actorUserId") REFERENCES "Membership"("organizationId", "id", "userId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CatalogIdentification" ADD CONSTRAINT "CatalogIdentification_sessionId_actorUserId_fkey" FOREIGN KEY ("sessionId", "actorUserId") REFERENCES "Session"("id", "userId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CatalogIdentification" ADD CONSTRAINT "CatalogIdentification_organizationId_supplierId_referenceI_fkey" FOREIGN KEY ("organizationId", "supplierId", "referenceId") REFERENCES "SupplierCatalogItem"("organizationId", "supplierId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CatalogIdentification" ADD CONSTRAINT "CatalogIdentification_organizationId_supplierId_supplierPr_fkey" FOREIGN KEY ("organizationId", "supplierId", "supplierProductId") REFERENCES "SupplierProduct"("organizationId", "supplierId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- This namespace cannot bypass GTIN validation or occupy MaxBio's MB- namespace.
ALTER TABLE "SupplierScanIdentifier" ADD CONSTRAINT "SupplierScanIdentifier_value_check" CHECK (
  length("value") BETWEEN 1 AND 128 AND "value" = btrim("value")
  AND "normalizedValue" = "value" AND "value" !~ '[[:cntrl:]]'
  AND "value" !~ '^MB-'
  AND "value" !~ '^([0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$'
  AND "value" !~ '\((01|10|17|21)\)|^\](C1|d2|Q3)|^01[0-9]{14}(10|17|21)'
);
ALTER TABLE "CatalogIdentification" ADD CONSTRAINT "CatalogIdentification_hash_check" CHECK ("requestHash" ~ '^[a-f0-9]{64}$');
