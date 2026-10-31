-- V6: narrow pre-attempt receiver completion; no tables or existing rows are rewritten.
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
  ELSIF (to_jsonb(NEW)-ARRAY['fiscalStatus','receiverVatConditionId','receiverVatConditionLabel','customerSnapshot','version','updatedAt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['fiscalStatus','receiverVatConditionId','receiverVatConditionLabel','customerSnapshot','version','updatedAt']) THEN
   RAISE EXCEPTION 'Ready commercial invoice is immutable' USING ERRCODE='23514';
  END IF;
 END IF;
 -- Explicit pre-attempt completion only. Preserve every other commercial snapshot field.
 IF OLD.status='READY' AND NEW.status='READY' AND (
   NEW."customerSnapshot" IS DISTINCT FROM OLD."customerSnapshot" OR
   NEW."receiverVatConditionId" IS DISTINCT FROM OLD."receiverVatConditionId" OR
   NEW."receiverVatConditionLabel" IS DISTINCT FROM OLD."receiverVatConditionLabel"
 ) THEN
  IF OLD."fiscalStatus"<>'NOT_SUBMITTED' OR NEW."fiscalStatus"<>'NOT_SUBMITTED'
     OR NEW.version<>OLD.version+1
     OR EXISTS (SELECT 1 FROM "InvoiceFiscalAttempt" WHERE "organizationId"=OLD."organizationId" AND "invoiceId"=OLD.id)
     OR (NEW."customerSnapshot"-'cuit') IS DISTINCT FROM (OLD."customerSnapshot"-'cuit')
     OR jsonb_typeof(NEW."customerSnapshot"->'cuit') IS DISTINCT FROM 'string'
     OR NOT maxbio_valid_cuit(NEW."customerSnapshot"->>'cuit')
     OR NOT EXISTS (SELECT 1 FROM "Customer" c WHERE c.id=OLD."customerId" AND c."organizationId"=OLD."organizationId"
          AND c."archivedAt" IS NULL AND c.cuit=NEW."customerSnapshot"->>'cuit'
          AND c."arcaVatConditionId"=NEW."receiverVatConditionId"
          AND c."arcaVatConditionLabel"=NEW."receiverVatConditionLabel")
  THEN RAISE EXCEPTION 'Fiscal receiver completion requires matching customer data before the first attempt' USING ERRCODE='23514'; END IF;
 END IF;
 IF OLD."fiscalStatus"<>'NOT_SUBMITTED' AND (NEW."receiverVatConditionId" IS DISTINCT FROM OLD."receiverVatConditionId" OR NEW."receiverVatConditionLabel" IS DISTINCT FROM OLD."receiverVatConditionLabel") THEN
  RAISE EXCEPTION 'Fiscal receiver snapshot is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
