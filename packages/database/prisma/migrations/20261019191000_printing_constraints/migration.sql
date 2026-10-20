-- SQL CHECK accepts UNKNOWN: require nullable dimensions/schema keys explicitly.
ALTER TABLE "PrintAsset" DROP CONSTRAINT print_asset_valid;
ALTER TABLE "PrintAsset" ADD CONSTRAINT print_asset_valid CHECK (
 "contentHash" ~ '^[a-f0-9]{64}$' AND "byteSize">0 AND
 "storageKey" = "organizationId"::text || '/' || substring("storageKey" from 38) AND
 "storageKey" ~ '^[a-f0-9-]{36}/[a-f0-9-]{36}$' AND
 ((kind='BACKGROUND' AND "widthPx" IS NOT NULL AND "heightPx" IS NOT NULL AND "widthPx">0 AND "heightPx">0 AND
   "widthPx"<=8000 AND "heightPx"<=8000 AND "widthPx"::bigint*"heightPx"<=16000000) OR
 (kind='PDF' AND "widthPx" IS NULL AND "heightPx" IS NULL)));
ALTER TABLE "PrintTemplate" DROP CONSTRAINT print_template_geometry;
ALTER TABLE "PrintTemplate" ADD CONSTRAINT print_template_geometry CHECK (
 revision>0 AND "pageWidthMm" BETWEEN 40 AND 1000 AND "pageHeightMm" BETWEEN 40 AND 1000 AND
 "safeToleranceXmm" BETWEEN 0 AND 10 AND "safeToleranceYmm" BETWEEN 0 AND 10 AND
 jsonb_typeof(definition)='object' AND (definition->>'schemaVersion') IS NOT DISTINCT FROM '1' AND
 ((status='DRAFT' AND "publishedAt" IS NULL) OR (status='PUBLISHED' AND "publishedAt" IS NOT NULL)));
