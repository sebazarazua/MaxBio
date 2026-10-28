ALTER TYPE "ArcaCredentialStatus" ADD VALUE 'DISCARDED';
ALTER TABLE "ArcaCredential"
  ADD COLUMN "replacedAt" TIMESTAMPTZ(3),
  ADD COLUMN "discardedAt" TIMESTAMPTZ(3),
  ADD COLUMN "secretsDeletedAt" TIMESTAMPTZ(3);

-- Existing history only. No ACTIVE row or secret is changed by this migration.
UPDATE "ArcaCredential" SET "replacedAt" = "updatedAt" WHERE status = 'REPLACED';
ALTER TABLE "ArcaCredential" ADD CONSTRAINT arca_retirement CHECK (
  ("secretsDeletedAt" IS NULL OR status::text IN ('REPLACED', 'DISCARDED')) AND
  (status::text <> 'DISCARDED' OR "discardedAt" IS NOT NULL)
);
