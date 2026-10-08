CREATE TYPE "CustomerKind" AS ENUM ('HEALTH_INSURER', 'INSTITUTION', 'COMPANY', 'OTHER');

CREATE TABLE "Customer" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "kind" "CustomerKind" NOT NULL,
  "legalName" VARCHAR(200),
  "cuit" VARCHAR(11),
  "taxConditionText" VARCHAR(80),
  "addressLine" VARCHAR(250),
  "locality" VARCHAR(120),
  "province" VARCHAR(100),
  "postalCode" VARCHAR(20),
  "contactName" VARCHAR(160),
  "phone" VARCHAR(50),
  "email" VARCHAR(254),
  "notes" VARCHAR(1000),
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "archivedAt" TIMESTAMPTZ(3),
  "searchText" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Customer_organizationId_id_key" ON "Customer" ("organizationId", "id");
-- NULL CUITs are allowed; archived customers keep their historical unique value.
CREATE UNIQUE INDEX "Customer_organizationId_cuit_key" ON "Customer" ("organizationId", "cuit");
CREATE INDEX "Customer_organizationId_archivedAt_name_id_idx" ON "Customer" ("organizationId", "archivedAt", "name", "id");
CREATE INDEX "Customer_searchText_idx" ON "Customer" USING GIN ("searchText" gin_trgm_ops);
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION maxbio_valid_cuit(value TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE weights INTEGER[] := ARRAY[5,4,3,2,7,6,5,4,3,2]; total INTEGER := 0; digit INTEGER; position INTEGER;
BEGIN
  IF value !~ '^[0-9]{11}$' OR value = '00000000000' THEN RETURN FALSE; END IF;
  FOR position IN 1..10 LOOP total := total + substring(value FROM position FOR 1)::INTEGER * weights[position]; END LOOP;
  digit := (11 - total % 11) % 11;
  RETURN digit < 10 AND digit = right(value,1)::INTEGER;
END $$;
ALTER TABLE "Customer"
  ADD CONSTRAINT "Customer_name_check" CHECK (name = btrim(name) AND length(name) > 0 AND name !~ '[[:cntrl:]]'),
  ADD CONSTRAINT "Customer_version_check" CHECK (version > 0),
  ADD CONSTRAINT "Customer_cuit_check" CHECK (cuit IS NULL OR maxbio_valid_cuit(cuit)),
  ADD CONSTRAINT "Customer_lifecycle_check" CHECK ("archivedAt" IS NULL OR "archivedAt" >= "createdAt");

CREATE FUNCTION maxbio_customer_search_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchText" := lower(unaccent(concat_ws(' ',NEW.name,NEW."legalName",NEW.cuit,NEW."contactName",NEW.phone,NEW.email)));
  RETURN NEW;
END $$;
CREATE TRIGGER "Customer_search_document" BEFORE INSERT OR UPDATE ON "Customer" FOR EACH ROW EXECUTE FUNCTION maxbio_customer_search_document();
