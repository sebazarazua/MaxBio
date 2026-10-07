BEGIN;
ALTER TABLE "Supplier" ADD COLUMN "catalogPrefix" VARCHAR(32), ADD COLUMN "catalogNextSequence" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "SupplierCatalogItem"
  ADD COLUMN "internalReferenceCode" VARCHAR(38), ADD COLUMN "referenceSequence" INTEGER,
  ADD COLUMN "manufacturerText" VARCHAR(200), ADD COLUMN "modelText" VARCHAR(160),
  ADD COLUMN "categoryText" VARCHAR(160), ADD COLUMN "unitText" VARCHAR(80),
  ALTER COLUMN "supplierCode" DROP NOT NULL, ALTER COLUMN "description" DROP NOT NULL;
-- Alphabetic ordinal: 1=A, 26=Z, 27=AA. Shared by deterministic backfill.
CREATE FUNCTION maxbio_catalog_prefix(n bigint) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE result text := ''; remaining bigint := n;
BEGIN
  WHILE remaining > 0 LOOP
    remaining := remaining - 1;
    result := chr(65 + (remaining % 26)::integer) || result;
    remaining := remaining / 26;
  END LOOP;
  RETURN result;
END $$;
WITH catalogs AS (
  SELECT s.id, row_number() OVER (PARTITION BY s."organizationId" ORDER BY s."createdAt", s.id) AS ordinal
  FROM "Supplier" s WHERE EXISTS (SELECT 1 FROM "SupplierCatalogItem" i WHERE i."supplierId"=s.id AND i."organizationId"=s."organizationId")
)
UPDATE "Supplier" s SET "catalogPrefix"=maxbio_catalog_prefix(c.ordinal) FROM catalogs c WHERE s.id=c.id;
WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY "organizationId", "supplierId" ORDER BY "createdAt", id)::integer AS seq FROM "SupplierCatalogItem"
)
UPDATE "SupplierCatalogItem" i SET "referenceSequence"=n.seq, "internalReferenceCode"=s."catalogPrefix" || lpad(n.seq::text,6,'0')
FROM numbered n, "Supplier" s WHERE i.id=n.id AND s.id=i."supplierId" AND s."organizationId"=i."organizationId";
UPDATE "Supplier" s SET "catalogNextSequence"=1+(SELECT COALESCE(max(i."referenceSequence"),0) FROM "SupplierCatalogItem" i WHERE i."supplierId"=s.id AND i."organizationId"=s."organizationId");
-- Ceiling in exact PostgreSQL numeric BEFORE narrowing; never ordinary rounding.
UPDATE "SupplierCatalogItem" SET price=ceil(price*100)/100 WHERE price IS NOT NULL;
ALTER TABLE "SupplierCatalogItem" ALTER COLUMN price TYPE DECIMAL(17,2), ALTER COLUMN "referenceSequence" SET NOT NULL, ALTER COLUMN "internalReferenceCode" SET NOT NULL;
-- Preserve commercial snapshots, adding nullable fields and definitive codes where linked.
UPDATE "SupplierCatalogImportRow" r SET data=data || jsonb_build_object(
  'internalReferenceCode',(SELECT i."internalReferenceCode" FROM "SupplierCatalogItem" i WHERE i.id=r."itemId" AND i."organizationId"=r."organizationId"),
  'manufacturerText',NULL,'modelText',NULL,'categoryText',NULL,'unitText',NULL,
  'price',CASE WHEN data->>'price' IS NOT NULL THEN to_char(ceil((data->>'price')::numeric*100)/100,'FM999999999999990.00') ELSE NULL END
) WHERE data IS NOT NULL AND jsonb_typeof(data)='object';
-- Pending old previews must be analyzed again; their signed interpretation has changed.
UPDATE "SupplierCatalogImport" SET "expiresAt"=LEAST("expiresAt", CURRENT_TIMESTAMP) WHERE status='PREVIEW';
CREATE UNIQUE INDEX "Supplier_organizationId_catalogPrefix_key" ON "Supplier"("organizationId","catalogPrefix");
CREATE UNIQUE INDEX "SupplierCatalogItem_organizationId_internalReferenceCode_key" ON "SupplierCatalogItem"("organizationId","internalReferenceCode");
CREATE UNIQUE INDEX "SupplierCatalogItem_organizationId_supplierId_referenceSequence_key" ON "SupplierCatalogItem"("organizationId","supplierId","referenceSequence");
CREATE INDEX "SupplierCatalogItem_organizationId_supplierId_archivedAt_refer_idx" ON "SupplierCatalogItem"("organizationId","supplierId","archivedAt","referenceSequence",id);
CREATE INDEX "SupplierCatalogItem_reference_prefix_idx" ON "SupplierCatalogItem"("organizationId","internalReferenceCode" text_pattern_ops);
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_catalog_allocator_check" CHECK (("catalogPrefix" IS NULL OR "catalogPrefix" ~ '^[A-Z]{1,32}$') AND "catalogNextSequence" BETWEEN 1 AND 1000000);
ALTER TABLE "SupplierCatalogItem" ADD CONSTRAINT "SupplierCatalogItem_reference_check" CHECK ("referenceSequence" BETWEEN 1 AND 999999 AND "internalReferenceCode" ~ '^[A-Z]+[0-9]{6}$' AND ("supplierCode" IS NOT NULL OR "description" IS NOT NULL OR "normalizedReportedGtin" IS NOT NULL));
CREATE FUNCTION maxbio_catalog_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prefix text;
BEGIN
  IF TG_OP='UPDATE' AND (NEW."internalReferenceCode",NEW."referenceSequence",NEW."supplierId",NEW."organizationId") IS DISTINCT FROM (OLD."internalReferenceCode",OLD."referenceSequence",OLD."supplierId",OLD."organizationId") THEN
    RAISE EXCEPTION 'Catalog reference identity is immutable';
  END IF;
  SELECT "catalogPrefix" INTO prefix FROM "Supplier" WHERE id=NEW."supplierId" AND "organizationId"=NEW."organizationId";
  IF prefix IS NULL OR NEW."internalReferenceCode" <> prefix || lpad(NEW."referenceSequence"::text,6,'0') THEN RAISE EXCEPTION 'Incoherent catalog reference code'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "SupplierCatalogItem_identity_guard" BEFORE INSERT OR UPDATE ON "SupplierCatalogItem" FOR EACH ROW EXECUTE FUNCTION maxbio_catalog_identity_guard();
CREATE FUNCTION maxbio_catalog_prefix_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."catalogPrefix" IS NOT NULL AND NEW."catalogPrefix" IS DISTINCT FROM OLD."catalogPrefix" THEN RAISE EXCEPTION 'Catalog prefix is reserved'; END IF;
  IF NEW."catalogNextSequence" < OLD."catalogNextSequence" THEN RAISE EXCEPTION 'Catalog sequence cannot rewind'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Supplier_catalog_prefix_guard" BEFORE UPDATE ON "Supplier" FOR EACH ROW EXECUTE FUNCTION maxbio_catalog_prefix_guard();
DROP FUNCTION maxbio_catalog_prefix(bigint);
-- Materialized search documents keep unaccent out of per-read scans and Prisma filters.
-- unaccent is a trusted PostgreSQL extension, installed through this migration.
CREATE EXTENSION IF NOT EXISTS unaccent;
ALTER TABLE "Supplier" ADD COLUMN "searchText" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Product" ADD COLUMN "searchText" TEXT NOT NULL DEFAULT '';
ALTER TABLE "SupplierCatalogItem" ADD COLUMN "searchText" TEXT NOT NULL DEFAULT '';
CREATE FUNCTION maxbio_search_document() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE related text;
BEGIN
  IF TG_TABLE_NAME='Supplier' THEN
    NEW."searchText" := lower(unaccent(concat_ws(' ',NEW.name,NEW."legalName",NEW."contactName",NEW.email,NEW.phone)));
  ELSIF TG_TABLE_NAME='Product' THEN
    -- On INSERT the Product row is not visible yet; query classifications directly.
    related := concat_ws(' ',(SELECT name FROM "Brand" WHERE id=NEW."brandId" AND "organizationId"=NEW."organizationId"),(SELECT name FROM "Category" WHERE id=NEW."categoryId" AND "organizationId"=NEW."organizationId"));
    NEW."searchText" := lower(unaccent(concat_ws(' ',NEW.name,NEW."manufacturerName",NEW.model,NEW.presentation,related)));
  ELSE
    SELECT name INTO related FROM "Supplier" WHERE id=NEW."supplierId" AND "organizationId"=NEW."organizationId";
    NEW."searchText" := lower(unaccent(concat_ws(' ',NEW."internalReferenceCode",NEW."supplierCode",NEW."alternateSupplierCode",NEW.description,NEW."brandText",NEW."manufacturerText",NEW."modelText",NEW."categoryText",NEW."presentationText",NEW."unitText",NEW."reportedGtin",NEW."normalizedReportedGtin",related)));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Supplier_search_document" BEFORE INSERT OR UPDATE ON "Supplier" FOR EACH ROW EXECUTE FUNCTION maxbio_search_document();
CREATE TRIGGER "Product_search_document" BEFORE INSERT OR UPDATE ON "Product" FOR EACH ROW EXECUTE FUNCTION maxbio_search_document();
CREATE TRIGGER "SupplierCatalogItem_search_document" BEFORE INSERT OR UPDATE ON "SupplierCatalogItem" FOR EACH ROW EXECUTE FUNCTION maxbio_search_document();
CREATE FUNCTION maxbio_refresh_related_search() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='Supplier' THEN
    IF NEW.name IS DISTINCT FROM OLD.name THEN UPDATE "SupplierCatalogItem" SET "searchText"='' WHERE "organizationId"=NEW."organizationId" AND "supplierId"=NEW.id; END IF;
  ELSIF TG_TABLE_NAME='Brand' THEN
    IF NEW.name IS DISTINCT FROM OLD.name THEN UPDATE "Product" SET "searchText"='' WHERE "organizationId"=NEW."organizationId" AND "brandId"=NEW.id; END IF;
  ELSIF TG_TABLE_NAME='Category' THEN
    IF NEW.name IS DISTINCT FROM OLD.name THEN UPDATE "Product" SET "searchText"='' WHERE "organizationId"=NEW."organizationId" AND "categoryId"=NEW.id; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Supplier_refresh_search" AFTER UPDATE ON "Supplier" FOR EACH ROW EXECUTE FUNCTION maxbio_refresh_related_search();
CREATE TRIGGER "Brand_refresh_search" AFTER UPDATE ON "Brand" FOR EACH ROW EXECUTE FUNCTION maxbio_refresh_related_search();
CREATE TRIGGER "Category_refresh_search" AFTER UPDATE ON "Category" FOR EACH ROW EXECUTE FUNCTION maxbio_refresh_related_search();
UPDATE "Supplier" SET "searchText"='';
UPDATE "Product" SET "searchText"='';
UPDATE "SupplierCatalogItem" SET "searchText"='';
COMMIT;
