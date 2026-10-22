CREATE TABLE "DeliveryNoteNumbering" (
  "organizationId" UUID NOT NULL,
  "prefix" VARCHAR(12) NOT NULL,
  "nextNumber" BIGINT NOT NULL,
  "numberWidth" INTEGER NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "DeliveryNoteNumbering_pkey" PRIMARY KEY ("organizationId"),
  CONSTRAINT "DeliveryNoteNumbering_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "delivery_numbering_values" CHECK ("prefix" ~ '^[0-9]{1,12}$' AND "nextNumber" BETWEEN 0 AND 1000000000000 AND "numberWidth" BETWEEN 1 AND 12 AND "version" >= 1)
);
-- The most recently created numbered paper selects the prefix. Numeric maximum,
-- all statuses, preserves historical strings and never invents a new prefix.
WITH latest AS (
  SELECT DISTINCT ON ("organizationId") "organizationId", "documentPrefix" AS prefix
  FROM "DeliveryNote" WHERE "documentPrefix" IS NOT NULL AND "documentNumber" IS NOT NULL
  ORDER BY "organizationId", "createdAt" DESC, id DESC
)
INSERT INTO "DeliveryNoteNumbering" ("organizationId", prefix, "nextNumber", "numberWidth", "updatedAt")
SELECT l."organizationId", l.prefix, MAX(d."documentNumber"::bigint) + 1, MAX(length(d."documentNumber")), CURRENT_TIMESTAMP
FROM latest l JOIN "DeliveryNote" d ON d."organizationId" = l."organizationId" AND d."documentPrefix" = l.prefix
WHERE d."documentNumber" IS NOT NULL GROUP BY l."organizationId", l.prefix;
