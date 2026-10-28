-- CreateEnum
CREATE TYPE "InvoiceFiscalStatus" AS ENUM ('NOT_SUBMITTED', 'AUTHORIZING', 'AUTHORIZED', 'REJECTED', 'UNCERTAIN', 'CONFLICT');

-- CreateEnum
CREATE TYPE "InvoiceFiscalAttemptStatus" AS ENUM ('PREPARING', 'AUTHORIZING', 'AUTHORIZED', 'REJECTED', 'UNCERTAIN', 'CONFLICT', 'NOT_FOUND', 'ABORTED');

-- AlterTable
ALTER TABLE "ArcaIntegrationConfig" ADD COLUMN     "pointOfSale" INTEGER,
ADD COLUMN     "pointOfSaleCuit" VARCHAR(11),
ADD COLUMN     "pointOfSaleValidatedAt" TIMESTAMPTZ(3),
ADD COLUMN     "wsfeCheckedAt" TIMESTAMPTZ(3),
ADD COLUMN     "wsfeCredentialId" UUID,
ADD COLUMN     "wsfeCuit" VARCHAR(11),
ADD COLUMN     "wsfeReferences" JSONB;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "arcaVatConditionId" INTEGER,
ADD COLUMN     "arcaVatConditionLabel" VARCHAR(180);

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "fiscalStatus" "InvoiceFiscalStatus" NOT NULL DEFAULT 'NOT_SUBMITTED',
ADD COLUMN     "receiverVatConditionId" INTEGER,
ADD COLUMN     "receiverVatConditionLabel" VARCHAR(180);

-- CreateTable
CREATE TABLE "InvoiceFiscalAttempt" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "operationId" UUID NOT NULL,
    "operationHash" CHAR(64) NOT NULL,
    "environment" "ArcaEnvironment" NOT NULL DEFAULT 'HOMOLOGATION',
    "issuerCuit" VARCHAR(11) NOT NULL,
    "pointOfSale" INTEGER NOT NULL,
    "documentType" INTEGER NOT NULL,
    "documentNumber" INTEGER,
    "status" "InvoiceFiscalAttemptStatus" NOT NULL DEFAULT 'PREPARING',
    "ownerId" UUID NOT NULL,
    "leaseUntil" TIMESTAMPTZ(3) NOT NULL,
    "issuerSnapshot" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "requestHash" CHAR(64),
    "result" CHAR(1),
    "messages" JSONB NOT NULL DEFAULT '[]',
    "observations" JSONB NOT NULL DEFAULT '[]',
    "events" JSONB NOT NULL DEFAULT '[]',
    "cae" VARCHAR(14),
    "caeExpiration" DATE,
    "authorizedAt" TIMESTAMPTZ(3),
    "sentAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "verifiedAt" TIMESTAMPTZ(3),
    "reconciliation" VARCHAR(40),
    "notFoundChecks" INTEGER NOT NULL DEFAULT 0,
    "lastNotFoundAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "InvoiceFiscalAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiscalSequence" (
    "organizationId" UUID NOT NULL,
    "environment" "ArcaEnvironment" NOT NULL DEFAULT 'HOMOLOGATION',
    "pointOfSale" INTEGER NOT NULL,
    "documentType" INTEGER NOT NULL,
    "blockedAttemptId" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "FiscalSequence_pkey" PRIMARY KEY ("organizationId","environment","pointOfSale","documentType")
);

-- CreateIndex
CREATE INDEX "InvoiceFiscalAttempt_organizationId_environment_pointOfSale_idx" ON "InvoiceFiscalAttempt"("organizationId", "environment", "pointOfSale", "documentType", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceFiscalAttempt_organizationId_id_key" ON "InvoiceFiscalAttempt"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceFiscalAttempt_organizationId_operationId_key" ON "InvoiceFiscalAttempt"("organizationId", "operationId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceFiscalAttempt_organizationId_invoiceId_ordinal_key" ON "InvoiceFiscalAttempt"("organizationId", "invoiceId", "ordinal");

-- AddForeignKey
ALTER TABLE "InvoiceFiscalAttempt" ADD CONSTRAINT "InvoiceFiscalAttempt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceFiscalAttempt" ADD CONSTRAINT "InvoiceFiscalAttempt_organizationId_invoiceId_fkey" FOREIGN KEY ("organizationId", "invoiceId") REFERENCES "Invoice"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FiscalSequence" ADD CONSTRAINT "FiscalSequence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "FiscalSequence" ADD CONSTRAINT "FiscalSequence_organizationId_blockedAttemptId_fkey" FOREIGN KEY ("organizationId", "blockedAttemptId") REFERENCES "InvoiceFiscalAttempt"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Candidate numbers may recur after definitive rejection/confirmed absence. Only an
-- authorized fiscal identity is unique; open candidates are serialized by the reservation.
CREATE UNIQUE INDEX invoice_fiscal_authorized_number ON "InvoiceFiscalAttempt" ("organizationId",environment,"pointOfSale","documentType","documentNumber") WHERE status='AUTHORIZED';
CREATE UNIQUE INDEX invoice_fiscal_one_open ON "InvoiceFiscalAttempt" ("organizationId","invoiceId") WHERE status IN ('PREPARING','AUTHORIZING','UNCERTAIN','CONFLICT');
ALTER TABLE "Customer" ADD CONSTRAINT customer_arca_vat CHECK (("arcaVatConditionId" IS NULL)=("arcaVatConditionLabel" IS NULL) AND ("arcaVatConditionId" IS NULL OR "arcaVatConditionId">0));
ALTER TABLE "ArcaIntegrationConfig" ADD CONSTRAINT wsfe_configuration_values CHECK (
 ("pointOfSale" IS NULL AND "pointOfSaleCuit" IS NULL AND "pointOfSaleValidatedAt" IS NULL) OR
 ("pointOfSale" BETWEEN 1 AND 99999 AND "pointOfSaleCuit" IS NOT NULL AND maxbio_valid_cuit("pointOfSaleCuit") AND "pointOfSaleValidatedAt" IS NOT NULL));
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_fiscal_values CHECK (
 (status='READY' OR "fiscalStatus"='NOT_SUBMITTED') AND
 (("receiverVatConditionId" IS NULL)=("receiverVatConditionLabel" IS NULL)) AND ("receiverVatConditionId" IS NULL OR "receiverVatConditionId">0));
ALTER TABLE "InvoiceFiscalAttempt" ADD CONSTRAINT invoice_fiscal_attempt_values CHECK (
 environment='HOMOLOGATION' AND maxbio_valid_cuit("issuerCuit") AND "pointOfSale" BETWEEN 1 AND 99999 AND "documentType" IN (1,6,11) AND ordinal>0 AND
 ("documentNumber" IS NULL OR "documentNumber" BETWEEN 1 AND 99999999) AND
 ((status='AUTHORIZED')=(cae IS NOT NULL)) AND ((cae IS NULL)=("caeExpiration" IS NULL)) AND ((cae IS NULL)=("authorizedAt" IS NULL)) AND
 (status<>'AUTHORIZED' OR (cae ~ '^[0-9]{14}$' AND result IS NOT NULL AND result='A' AND "documentNumber" IS NOT NULL AND "requestHash" IS NOT NULL AND "sentAt" IS NOT NULL AND "completedAt" IS NOT NULL)) AND
 (status<>'REJECTED' OR (result IS NOT NULL AND result='R' AND "completedAt" IS NOT NULL)) AND
 (status NOT IN ('AUTHORIZING','UNCERTAIN','CONFLICT','NOT_FOUND') OR ("documentNumber" IS NOT NULL AND "requestHash" IS NOT NULL AND "sentAt" IS NOT NULL)) AND
 jsonb_typeof(payload)='object' AND jsonb_typeof("issuerSnapshot")='object' AND jsonb_typeof(messages)='array' AND jsonb_typeof(observations)='array' AND jsonb_typeof(events)='array');
ALTER TABLE "FiscalSequence" ADD CONSTRAINT fiscal_sequence_values CHECK (environment='HOMOLOGATION' AND "pointOfSale" BETWEEN 1 AND 99999 AND "documentType" IN (1,6,11));
CREATE FUNCTION maxbio_fiscal_sequence_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD."blockedAttemptId" IS NOT NULL THEN RAISE EXCEPTION 'Reserved fiscal sequences cannot be deleted' USING ERRCODE='23514'; END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER fiscal_sequence_delete_guard BEFORE DELETE ON "FiscalSequence" FOR EACH ROW EXECUTE FUNCTION maxbio_fiscal_sequence_delete_guard();

CREATE OR REPLACE FUNCTION maxbio_invoice_document_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.status<>'DRAFT' OR OLD."fiscalStatus"<>'NOT_SUBMITTED' THEN RAISE EXCEPTION 'Only unfiscalized drafts can be discarded' USING ERRCODE='23514'; END IF;
  RETURN OLD;
 END IF;
 IF NEW.id<>OLD.id OR NEW."organizationId"<>OLD."organizationId" OR NEW."customerId"<>OLD."customerId" OR NEW."creationHash"<>OLD."creationHash" OR NEW."createdAt"<>OLD."createdAt" THEN
  RAISE EXCEPTION 'Invoice identity is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.status='READY' THEN
  IF NEW.status='DRAFT' THEN
   IF OLD."fiscalStatus" NOT IN ('NOT_SUBMITTED','REJECTED') OR NEW."invoiceType" IS DISTINCT FROM OLD."invoiceType" OR NEW."issueDate"<>OLD."issueDate" OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW."netAmount"<>OLD."netAmount" OR NEW."vatAmount"<>OLD."vatAmount" OR NEW."totalAmount"<>OLD."totalAmount" THEN
    RAISE EXCEPTION 'Fiscal invoice cannot be reopened' USING ERRCODE='23514';
   END IF;
  ELSIF (to_jsonb(NEW)-ARRAY['fiscalStatus','receiverVatConditionId','receiverVatConditionLabel','version','updatedAt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['fiscalStatus','receiverVatConditionId','receiverVatConditionLabel','version','updatedAt']) THEN
   RAISE EXCEPTION 'Ready commercial invoice is immutable' USING ERRCODE='23514';
  END IF;
 END IF;
 IF OLD."fiscalStatus"<>'NOT_SUBMITTED' AND (NEW."receiverVatConditionId" IS DISTINCT FROM OLD."receiverVatConditionId" OR NEW."receiverVatConditionLabel" IS DISTINCT FROM OLD."receiverVatConditionLabel") THEN
  RAISE EXCEPTION 'Fiscal receiver snapshot is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION maxbio_fiscal_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Fiscal attempts are retained' USING ERRCODE='23514'; END IF;
 IF NEW.id<>OLD.id OR NEW."organizationId"<>OLD."organizationId" OR NEW."invoiceId"<>OLD."invoiceId" OR NEW.ordinal<>OLD.ordinal OR NEW."operationId"<>OLD."operationId" OR NEW."operationHash"<>OLD."operationHash" OR NEW."pointOfSale"<>OLD."pointOfSale" OR NEW."documentType"<>OLD."documentType" OR NEW.environment<>OLD.environment OR NEW."issuerSnapshot"<>OLD."issuerSnapshot" OR NEW."issuerCuit"<>OLD."issuerCuit" OR NEW."ownerId"<>OLD."ownerId" OR NEW."leaseUntil"<>OLD."leaseUntil" OR NEW."createdAt"<>OLD."createdAt" THEN
  RAISE EXCEPTION 'Fiscal attempt identity is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.status<>'PREPARING' AND (NEW.payload<>OLD.payload OR NEW."requestHash" IS DISTINCT FROM OLD."requestHash" OR NEW."documentNumber" IS DISTINCT FROM OLD."documentNumber" OR NEW."sentAt" IS DISTINCT FROM OLD."sentAt") THEN
  RAISE EXCEPTION 'Fiscal request is immutable after reservation' USING ERRCODE='23514';
 END IF;
 IF OLD.status='AUTHORIZED' AND (to_jsonb(NEW)-ARRAY['verifiedAt','reconciliation','updatedAt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['verifiedAt','reconciliation','updatedAt']) THEN
  RAISE EXCEPTION 'Authorized fiscal result is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.status IN ('REJECTED','NOT_FOUND','ABORTED') THEN RAISE EXCEPTION 'Terminal fiscal history is immutable' USING ERRCODE='23514'; END IF;
 IF OLD.status='PREPARING' AND NEW.status NOT IN ('AUTHORIZING','ABORTED') THEN RAISE EXCEPTION 'Invalid preparation transition' USING ERRCODE='23514'; END IF;
 IF OLD.status='AUTHORIZING' AND NEW.status NOT IN ('AUTHORIZED','REJECTED','UNCERTAIN','CONFLICT') THEN RAISE EXCEPTION 'Invalid authorization transition' USING ERRCODE='23514'; END IF;
 IF OLD.status IN ('UNCERTAIN','CONFLICT') AND NEW.status NOT IN ('AUTHORIZED','UNCERTAIN','CONFLICT','NOT_FOUND') THEN RAISE EXCEPTION 'Invalid reconciliation transition' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fiscal_attempt_guard BEFORE UPDATE OR DELETE ON "InvoiceFiscalAttempt" FOR EACH ROW EXECUTE FUNCTION maxbio_fiscal_attempt_guard();
CREATE FUNCTION maxbio_fiscal_attempt_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inv "Invoice";
BEGIN
 SELECT * INTO inv FROM "Invoice" WHERE id=NEW."invoiceId" AND "organizationId"=NEW."organizationId" FOR UPDATE;
 IF NOT FOUND OR inv.status<>'READY' OR inv."fiscalStatus"<>'NOT_SUBMITTED' OR NEW.status<>'PREPARING' OR EXISTS (SELECT 1 FROM "InvoiceFiscalAttempt" WHERE "invoiceId"=inv.id AND "organizationId"=inv."organizationId" AND status='AUTHORIZED') THEN
  RAISE EXCEPTION 'Fiscal attempt requires an unsubmitted ready invoice' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fiscal_attempt_insert_guard BEFORE INSERT ON "InvoiceFiscalAttempt" FOR EACH ROW EXECUTE FUNCTION maxbio_fiscal_attempt_insert_guard();

-- Deferred consistency: fiscal results and Invoice projection must commit together.
CREATE FUNCTION maxbio_fiscal_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE iid uuid; org uuid; inv "Invoice"; a "InvoiceFiscalAttempt"; seq "FiscalSequence";
BEGIN
 IF TG_TABLE_NAME='Invoice' THEN iid:=NEW.id; org:=NEW."organizationId";
 ELSIF TG_TABLE_NAME='InvoiceFiscalAttempt' THEN iid:=NEW."invoiceId"; org:=NEW."organizationId";
 ELSE
  IF TG_OP='UPDATE' AND OLD."blockedAttemptId" IS NOT NULL AND NEW."blockedAttemptId" IS DISTINCT FROM OLD."blockedAttemptId" THEN
   SELECT * INTO a FROM "InvoiceFiscalAttempt" WHERE id=OLD."blockedAttemptId" AND "organizationId"=OLD."organizationId";
   IF a.status IN ('PREPARING','AUTHORIZING','UNCERTAIN','CONFLICT') OR EXISTS (SELECT 1 FROM "Invoice" WHERE id=a."invoiceId" AND "organizationId"=a."organizationId" AND "fiscalStatus"='CONFLICT') THEN RAISE EXCEPTION 'Unresolved sequence cannot be released' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW."blockedAttemptId" IS NOT NULL THEN
   SELECT * INTO a FROM "InvoiceFiscalAttempt" WHERE id=NEW."blockedAttemptId" AND "organizationId"=NEW."organizationId";
   IF NOT FOUND OR a.environment<>NEW.environment OR a."pointOfSale"<>NEW."pointOfSale" OR a."documentType"<>NEW."documentType" THEN RAISE EXCEPTION 'Sequence scope mismatch' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NULL;
 END IF;
 SELECT * INTO inv FROM "Invoice" WHERE id=iid AND "organizationId"=org;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO a FROM "InvoiceFiscalAttempt" WHERE "invoiceId"=iid AND "organizationId"=org ORDER BY ordinal DESC LIMIT 1;
 IF NOT FOUND THEN
  IF inv."fiscalStatus"<>'NOT_SUBMITTED' THEN RAISE EXCEPTION 'Fiscal status requires an attempt' USING ERRCODE='23514'; END IF;
  RETURN NULL;
 END IF;
 IF (a.status IN ('PREPARING','AUTHORIZING') AND inv."fiscalStatus"<>'AUTHORIZING') OR
    (a.status='AUTHORIZED' AND inv."fiscalStatus" NOT IN ('AUTHORIZED','CONFLICT')) OR
    (a.status='REJECTED' AND inv."fiscalStatus" NOT IN ('REJECTED','NOT_SUBMITTED')) OR
    (a.status IN ('UNCERTAIN','CONFLICT') AND inv."fiscalStatus"::text<>a.status::text) OR
    (a.status IN ('NOT_FOUND','ABORTED') AND inv."fiscalStatus"<>'NOT_SUBMITTED') THEN
  RAISE EXCEPTION 'Invoice fiscal projection mismatch' USING ERRCODE='23514';
 END IF;
 IF a.status IN ('PREPARING','AUTHORIZING','UNCERTAIN','CONFLICT') OR inv."fiscalStatus"='CONFLICT' THEN
  SELECT * INTO seq FROM "FiscalSequence" WHERE "organizationId"=org AND environment=a.environment AND "pointOfSale"=a."pointOfSale" AND "documentType"=a."documentType";
  IF NOT FOUND OR seq."blockedAttemptId" IS DISTINCT FROM a.id THEN RAISE EXCEPTION 'Unresolved fiscal attempt requires sequence reservation' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER invoice_fiscal_consistency AFTER INSERT OR UPDATE ON "Invoice" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maxbio_fiscal_consistency();
CREATE CONSTRAINT TRIGGER fiscal_attempt_consistency AFTER INSERT OR UPDATE ON "InvoiceFiscalAttempt" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maxbio_fiscal_consistency();
CREATE CONSTRAINT TRIGGER fiscal_sequence_consistency AFTER INSERT OR UPDATE ON "FiscalSequence" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maxbio_fiscal_consistency();
