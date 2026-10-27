-- V2 invariants: no secrets or tenant defaults, one active and one pending credential.
CREATE UNIQUE INDEX arca_one_active ON "ArcaCredential" ("organizationId", "environment") WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX arca_one_pending ON "ArcaCredential" ("organizationId", "environment") WHERE status IN ('CSR_READY', 'CERTIFICATE_INSTALLED');
ALTER TABLE "OrganizationFiscalProfile"
  ADD CONSTRAINT fiscal_version CHECK (version > 0),
  ADD CONSTRAINT fiscal_cuit CHECK (cuit IS NULL OR maxbio_valid_cuit(cuit)),
  ADD CONSTRAINT fiscal_country CHECK (country IS NULL OR country = 'AR'),
  ADD CONSTRAINT fiscal_activity CHECK (("nationalActivityCode" IS NULL OR "nationalActivityCode" ~ '^[0-9]{6}$') AND ("multilateralActivityCode" IS NULL OR "multilateralActivityCode" ~ '^[0-9]{6}$'));
ALTER TABLE "ArcaIntegrationConfig"
  ADD CONSTRAINT arca_config_values CHECK (version > 0 AND service = 'wsfe' AND environment = 'HOMOLOGATION');
ALTER TABLE "ArcaCredential"
  ADD CONSTRAINT arca_credential_values CHECK (version > 0 AND maxbio_valid_cuit(cuit) AND environment = 'HOMOLOGATION'),
  ADD CONSTRAINT arca_storage_scope CHECK (
    "privateKeyStorageKey" ~ ('^' || "organizationId"::text || '/[a-f0-9-]{36}$') AND
    "csrStorageKey" ~ ('^' || "organizationId"::text || '/[a-f0-9-]{36}$') AND
    ("certificateStorageKey" IS NULL OR "certificateStorageKey" ~ ('^' || "organizationId"::text || '/[a-f0-9-]{36}$'))),
  ADD CONSTRAINT arca_certificate_complete CHECK (
    status NOT IN ('CERTIFICATE_INSTALLED', 'ACTIVE') OR (
      "certificateStorageKey" IS NOT NULL AND "certificateFingerprint" IS NOT NULL AND
      "certificateSubject" IS NOT NULL AND "certificateIssuer" IS NOT NULL AND "certificateSerial" IS NOT NULL AND
      "validFrom" IS NOT NULL AND "validTo" IS NOT NULL AND "validFrom" < "validTo"));
