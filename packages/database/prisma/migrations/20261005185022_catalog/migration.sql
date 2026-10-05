-- CreateEnum
CREATE TYPE "UnitOfMeasure" AS ENUM ('UNIT', 'PAIR', 'METER', 'CENTIMETER', 'LITER', 'MILLILITER', 'KILOGRAM', 'GRAM');

-- CreateEnum
CREATE TYPE "ProductIdentifierKind" AS ENUM ('GTIN', 'INTERNAL_CODE', 'INTERNAL_BARCODE');

-- CreateTable
CREATE TABLE "Product" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(4000),
    "presentation" VARCHAR(200),
    "unitOfMeasure" "UnitOfMeasure" NOT NULL,
    "model" VARCHAR(160),
    "manufacturerName" VARCHAR(160),
    "brandId" UUID,
    "categoryId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductIdentifier" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "kind" "ProductIdentifierKind" NOT NULL,
    "value" VARCHAR(128) NOT NULL,
    "normalizedValue" VARCHAR(128) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ProductIdentifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "legalName" VARCHAR(200),
    "contactName" VARCHAR(160),
    "email" VARCHAR(254),
    "phone" VARCHAR(50),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierProduct" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "supplierCode" VARCHAR(128),
    "supplierDescription" VARCHAR(1000),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "SupplierProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Brand" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "normalizedName" VARCHAR(160) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "normalizedName" VARCHAR(160) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Product_organizationId_archivedAt_name_id_idx" ON "Product"("organizationId", "archivedAt", "name", "id");

-- CreateIndex
CREATE INDEX "Product_organizationId_brandId_idx" ON "Product"("organizationId", "brandId");

-- CreateIndex
CREATE INDEX "Product_organizationId_categoryId_idx" ON "Product"("organizationId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_organizationId_id_key" ON "Product"("organizationId", "id");

-- CreateIndex
CREATE INDEX "ProductIdentifier_organizationId_productId_archivedAt_idx" ON "ProductIdentifier"("organizationId", "productId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProductIdentifier_organizationId_kind_normalizedValue_key" ON "ProductIdentifier"("organizationId", "kind", "normalizedValue");

-- CreateIndex
CREATE INDEX "Supplier_organizationId_archivedAt_name_id_idx" ON "Supplier"("organizationId", "archivedAt", "name", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_organizationId_id_key" ON "Supplier"("organizationId", "id");

-- CreateIndex
CREATE INDEX "SupplierProduct_organizationId_productId_archivedAt_idx" ON "SupplierProduct"("organizationId", "productId", "archivedAt");

-- CreateIndex
CREATE INDEX "SupplierProduct_organizationId_supplierCode_idx" ON "SupplierProduct"("organizationId", "supplierCode");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierProduct_organizationId_supplierId_productId_key" ON "SupplierProduct"("organizationId", "supplierId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierProduct_organizationId_supplierId_supplierCode_key" ON "SupplierProduct"("organizationId", "supplierId", "supplierCode");

-- CreateIndex
CREATE INDEX "Brand_organizationId_archivedAt_name_id_idx" ON "Brand"("organizationId", "archivedAt", "name", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_organizationId_id_key" ON "Brand"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_organizationId_normalizedName_key" ON "Brand"("organizationId", "normalizedName");

-- CreateIndex
CREATE INDEX "Category_organizationId_archivedAt_name_id_idx" ON "Category"("organizationId", "archivedAt", "name", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Category_organizationId_id_key" ON "Category"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Category_organizationId_normalizedName_key" ON "Category"("organizationId", "normalizedName");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_organizationId_brandId_fkey" FOREIGN KEY ("organizationId", "brandId") REFERENCES "Brand"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_organizationId_categoryId_fkey" FOREIGN KEY ("organizationId", "categoryId") REFERENCES "Category"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductIdentifier" ADD CONSTRAINT "ProductIdentifier_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductIdentifier" ADD CONSTRAINT "ProductIdentifier_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Brand" ADD CONSTRAINT "Brand_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Invariantes no representables en el schema Prisma 7: conservar en SQL.
CREATE FUNCTION maxbio_valid_gtin(value TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  total INTEGER := 0;
  weight INTEGER := 3;
  position INTEGER;
BEGIN
  IF value !~ '^([0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$' THEN RETURN FALSE; END IF;
  FOR position IN REVERSE length(value) - 1..1 LOOP
    total := total + substring(value FROM position FOR 1)::INTEGER * weight;
    weight := CASE WHEN weight = 3 THEN 1 ELSE 3 END;
  END LOOP;
  RETURN (10 - total % 10) % 10 = right(value, 1)::INTEGER;
END;
$$;

ALTER TABLE "Product" ADD CONSTRAINT "Product_name_check" CHECK (length(btrim("name")) > 0),
  ADD CONSTRAINT "Product_version_check" CHECK ("version" >= 1);
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_name_check" CHECK (length(btrim("name")) > 0),
  ADD CONSTRAINT "Supplier_version_check" CHECK ("version" >= 1);
ALTER TABLE "SupplierProduct" ADD CONSTRAINT "SupplierProduct_code_check"
  CHECK ("supplierCode" IS NULL OR (length("supplierCode") > 0 AND "supplierCode" = btrim("supplierCode"))),
  ADD CONSTRAINT "SupplierProduct_version_check" CHECK ("version" >= 1);
ALTER TABLE "Brand" ADD CONSTRAINT "Brand_name_check"
  CHECK (length("name") > 0 AND "name" = btrim("name") AND "name" !~ '[[:space:]]{2,}' AND "normalizedName" = lower("name")),
  ADD CONSTRAINT "Brand_version_check" CHECK ("version" >= 1);
ALTER TABLE "Category" ADD CONSTRAINT "Category_name_check"
  CHECK (length("name") > 0 AND "name" = btrim("name") AND "name" !~ '[[:space:]]{2,}' AND "normalizedName" = lower("name")),
  ADD CONSTRAINT "Category_version_check" CHECK ("version" >= 1);
ALTER TABLE "ProductIdentifier" ADD CONSTRAINT "ProductIdentifier_value_check"
  CHECK (length("value") > 0 AND "value" = btrim("value") AND "value" !~ '[[:cntrl:]]'),
  ADD CONSTRAINT "ProductIdentifier_normalization_check" CHECK (
    CASE "kind"
      WHEN 'GTIN' THEN maxbio_valid_gtin("value") AND "normalizedValue" = lpad("value", 14, '0')
      WHEN 'INTERNAL_CODE' THEN "normalizedValue" = "value"
      WHEN 'INTERNAL_BARCODE' THEN "value" ~ '^MB-[A-Z0-9][A-Z0-9._-]{0,60}$' AND "normalizedValue" = "value"
    END
  );
