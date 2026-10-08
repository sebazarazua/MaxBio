BEGIN;
-- A..Z precede AA..ZZ: length, then prefix, then item sequence.
-- Keep this derived value DB-owned so allocator/identity code stays unchanged.
ALTER TABLE "Supplier" ADD COLUMN "catalogPrefixLength" INTEGER;
UPDATE "Supplier" SET "catalogPrefixLength"=char_length("catalogPrefix");
CREATE FUNCTION maxbio_catalog_prefix_length() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."catalogPrefixLength" := char_length(NEW."catalogPrefix");
  RETURN NEW;
END $$;
CREATE TRIGGER "Supplier_catalog_prefix_length" BEFORE INSERT OR UPDATE ON "Supplier"
FOR EACH ROW EXECUTE FUNCTION maxbio_catalog_prefix_length();
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_catalog_prefix_length_check"
CHECK ("catalogPrefixLength" IS NOT DISTINCT FROM char_length("catalogPrefix"));
CREATE INDEX "Supplier_organizationId_catalogPrefixLength_catalogPrefix_idx"
ON "Supplier" ("organizationId","catalogPrefixLength","catalogPrefix");
COMMIT;
