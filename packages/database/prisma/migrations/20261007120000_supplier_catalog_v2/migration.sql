-- AlterTable
ALTER TABLE "SupplierCatalogItem" ADD COLUMN     "alternateSupplierCode" VARCHAR(128),
ADD COLUMN     "currency" VARCHAR(3),
ADD COLUMN     "price" DECIMAL(32,18),
ADD COLUMN     "priceIncludesVat" VARCHAR(7) NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "vatRate" DECIMAL(7,4);

-- AlterTable
ALTER TABLE "SupplierCatalogImport" ADD COLUMN     "commercial" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "formatFingerprint" CHAR(64),
ADD COLUMN     "formatHeaders" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "saveProfile" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "SupplierCatalogImportProfile" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "sheetName" VARCHAR(31) NOT NULL,
    "headerRow" INTEGER NOT NULL,
    "headers" JSONB NOT NULL,
    "mapping" JSONB NOT NULL,
    "commercial" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SupplierCatalogImportProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupplierCatalogImportProfile_organizationId_supplierId_fing_key" ON "SupplierCatalogImportProfile"("organizationId", "supplierId", "fingerprint");

-- AddForeignKey
ALTER TABLE "SupplierCatalogImportProfile" ADD CONSTRAINT "SupplierCatalogImportProfile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierCatalogImportProfile" ADD CONSTRAINT "SupplierCatalogImportProfile_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Commercial declarations, not Product prices. No inferred defaults or historical backfill.
ALTER TABLE "SupplierCatalogItem"
  ADD CONSTRAINT "SupplierCatalogItem_commercial_check" CHECK (
    ("price" IS NULL OR ("price" >= 0 AND "currency" IS NOT NULL)) AND
    ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$') AND
    ("vatRate" IS NULL OR "vatRate" BETWEEN 0 AND 100) AND
    "priceIncludesVat" IN ('YES','NO','UNKNOWN') AND
    ("alternateSupplierCode" IS NULL OR (length("alternateSupplierCode") > 0 AND "alternateSupplierCode" = btrim("alternateSupplierCode") AND "alternateSupplierCode" !~ '[[:cntrl:]]'))
  );
ALTER TABLE "SupplierCatalogImport"
  ADD CONSTRAINT "SupplierCatalogImport_commercial_check" CHECK (jsonb_typeof("commercial") = 'object' AND jsonb_typeof("formatHeaders") = 'array' AND ("formatFingerprint" IS NULL OR "formatFingerprint" ~ '^[a-f0-9]{64}$'));
ALTER TABLE "SupplierCatalogImportProfile"
  ADD CONSTRAINT "SupplierCatalogImportProfile_structure_check" CHECK (
    "fingerprint" ~ '^[a-f0-9]{64}$' AND "headerRow" BETWEEN 1 AND 20 AND length("sheetName") > 0 AND
    jsonb_typeof("headers") = 'array' AND jsonb_array_length("headers") BETWEEN 1 AND 100 AND
    jsonb_typeof("mapping") = 'object' AND jsonb_typeof("commercial") = 'object'
  );
