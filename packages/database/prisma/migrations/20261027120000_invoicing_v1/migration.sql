-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'READY');

-- CreateEnum
CREATE TYPE "InvoiceType" AS ENUM ('INVOICE_A', 'INVOICE_B', 'INVOICE_C');

-- CreateEnum
CREATE TYPE "InvoiceVatRate" AS ENUM ('VAT_0', 'VAT_10_5', 'VAT_21', 'VAT_27', 'EXEMPT', 'NOT_TAXED');

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "invoiceType" "InvoiceType",
    "issueDate" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'ARS',
    "exchangeRate" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "netAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "vatAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "notes" VARCHAR(1000),
    "customerSnapshot" JSONB,
    "creationHash" CHAR(64) NOT NULL,
    "lastOperationId" UUID,
    "lastOperationHash" CHAR(64),
    "readyAt" TIMESTAMPTZ(3),
    "readyByUserId" UUID,
    "readyByMembershipId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceDeliveryNote" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "deliveryNoteId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceDeliveryNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "deliveryNoteId" UUID NOT NULL,
    "deliveryNoteLineId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "productNameSnapshot" VARCHAR(200) NOT NULL,
    "presentationSnapshot" VARCHAR(200),
    "unitOfMeasure" "UnitOfMeasure" NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "unitPrice" DECIMAL(18,2),
    "vatRate" "InvoiceVatRate",
    "netAmount" DECIMAL(18,2),
    "vatAmount" DECIMAL(18,2),
    "totalAmount" DECIMAL(18,2),

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Invoice_organizationId_status_issueDate_id_idx" ON "Invoice"("organizationId", "status", "issueDate", "id");

-- CreateIndex
CREATE INDEX "Invoice_organizationId_customerId_idx" ON "Invoice"("organizationId", "customerId");

-- CreateIndex
CREATE INDEX "Invoice_organizationId_lastOperationId_idx" ON "Invoice"("organizationId", "lastOperationId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_organizationId_id_key" ON "Invoice"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_customer_scope" ON "Invoice"("organizationId", "id", "customerId");

-- CreateIndex
CREATE INDEX "InvoiceDeliveryNote_organizationId_invoiceId_ordinal_idx" ON "InvoiceDeliveryNote"("organizationId", "invoiceId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceDeliveryNote_organizationId_deliveryNoteId_key" ON "InvoiceDeliveryNote"("organizationId", "deliveryNoteId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceDeliveryNote_organizationId_deliveryNoteId_customerI_key" ON "InvoiceDeliveryNote"("organizationId", "deliveryNoteId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceDeliveryNote_organizationId_invoiceId_deliveryNoteId_key" ON "InvoiceDeliveryNote"("organizationId", "invoiceId", "deliveryNoteId");

-- CreateIndex
CREATE INDEX "InvoiceLine_organizationId_invoiceId_ordinal_idx" ON "InvoiceLine"("organizationId", "invoiceId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceLine_organizationId_deliveryNoteLineId_key" ON "InvoiceLine"("organizationId", "deliveryNoteLineId");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_note_customer_scope" ON "DeliveryNote"("organizationId", "id", "customerId");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_customerId_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "Customer"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_readyByMembershipId_readyByUserId_fkey" FOREIGN KEY ("organizationId", "readyByMembershipId", "readyByUserId") REFERENCES "Membership"("organizationId", "id", "userId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceDeliveryNote" ADD CONSTRAINT "InvoiceDeliveryNote_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceDeliveryNote" ADD CONSTRAINT "InvoiceDeliveryNote_organizationId_invoiceId_customerId_fkey" FOREIGN KEY ("organizationId", "invoiceId", "customerId") REFERENCES "Invoice"("organizationId", "id", "customerId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceDeliveryNote" ADD CONSTRAINT "InvoiceDeliveryNote_organizationId_deliveryNoteId_customer_fkey" FOREIGN KEY ("organizationId", "deliveryNoteId", "customerId") REFERENCES "DeliveryNote"("organizationId", "id", "customerId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_organizationId_invoiceId_fkey" FOREIGN KEY ("organizationId", "invoiceId") REFERENCES "Invoice"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_organizationId_invoiceId_deliveryNoteId_fkey" FOREIGN KEY ("organizationId", "invoiceId", "deliveryNoteId") REFERENCES "InvoiceDeliveryNote"("organizationId", "invoiceId", "deliveryNoteId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_organizationId_deliveryNoteId_productId_delive_fkey" FOREIGN KEY ("organizationId", "deliveryNoteId", "productId", "deliveryNoteLineId") REFERENCES "DeliveryNoteLine"("organizationId", "deliveryNoteId", "productId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Facturación V1 (interna, sin ARCA). Las reglas de dinero replican contracts/invoice-money:
-- neto = round(cantidad × precio, 2), IVA = round(neto × alícuota, 2), total = neto + IVA.
CREATE FUNCTION maxbio_invoice_vat_ratio(rate "InvoiceVatRate") RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE rate WHEN 'VAT_10_5' THEN 0.105 WHEN 'VAT_21' THEN 0.21 WHEN 'VAT_27' THEN 0.27 ELSE 0 END::numeric
$$;

ALTER TABLE "Invoice" ADD CONSTRAINT invoice_values CHECK (
 currency='ARS' AND "exchangeRate"=1 AND version>=1
 AND "netAmount">=0 AND "vatAmount">=0 AND "totalAmount"="netAmount"+"vatAmount"
 AND ((status='READY')=("readyAt" IS NOT NULL))
 AND (("readyAt" IS NULL)=("readyByUserId" IS NULL)) AND (("readyAt" IS NULL)=("readyByMembershipId" IS NULL))
 AND ((status='READY')=("customerSnapshot" IS NOT NULL))
 AND (status<>'READY' OR "invoiceType" IS NOT NULL)
 AND (("lastOperationId" IS NULL)=("lastOperationHash" IS NULL))
);
ALTER TABLE "InvoiceDeliveryNote" ADD CONSTRAINT invoice_delivery_note_values CHECK (ordinal>=0);
ALTER TABLE "InvoiceLine" ADD CONSTRAINT invoice_line_values CHECK (
 quantity>0 AND quantity<=1000000000.999999 AND ordinal>=0 AND length(btrim(description))>0
 AND ("unitPrice" IS NULL OR "unitPrice">=0)
 AND (("unitPrice" IS NOT NULL AND "vatRate" IS NOT NULL)=("netAmount" IS NOT NULL))
 AND (("netAmount" IS NULL)=("vatAmount" IS NULL)) AND (("netAmount" IS NULL)=("totalAmount" IS NULL))
 AND ("netAmount" IS NULL OR (
  "netAmount"=round(quantity*"unitPrice",2)
  AND "vatAmount"=round("netAmount"*maxbio_invoice_vat_ratio("vatRate"),2)
  AND "totalAmount"="netAmount"+"vatAmount"))
);

-- READY queda congelada: solo una vuelta explícita a DRAFT puede cambiarla, sin tocar montos.
CREATE FUNCTION maxbio_invoice_document_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.status<>'DRAFT' THEN RAISE EXCEPTION 'Only draft invoices can be discarded' USING ERRCODE='23514'; END IF;
  RETURN OLD;
 END IF;
 IF NEW.id<>OLD.id OR NEW."organizationId"<>OLD."organizationId" OR NEW."customerId"<>OLD."customerId" OR NEW."creationHash"<>OLD."creationHash" OR NEW."createdAt"<>OLD."createdAt" THEN
  RAISE EXCEPTION 'Invoice identity is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.status='READY' AND (NEW.status='READY' OR NEW."invoiceType" IS DISTINCT FROM OLD."invoiceType" OR NEW."issueDate"<>OLD."issueDate" OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW."netAmount"<>OLD."netAmount" OR NEW."vatAmount"<>OLD."vatAmount" OR NEW."totalAmount"<>OLD."totalAmount") THEN
  RAISE EXCEPTION 'Ready invoice is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER invoice_document_guard BEFORE UPDATE OR DELETE ON "Invoice" FOR EACH ROW EXECUTE FUNCTION maxbio_invoice_document_guard();

-- Vínculos fijos: solo Remitos CONFIRMED y solo mientras la factura es borrador.
CREATE FUNCTION maxbio_invoice_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE iid uuid; org uuid; open boolean;
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Invoice delivery note link is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN iid:=OLD."invoiceId"; org:=OLD."organizationId"; ELSE iid:=NEW."invoiceId"; org:=NEW."organizationId"; END IF;
 SELECT status='DRAFT' INTO open FROM "Invoice" WHERE id=iid AND "organizationId"=org FOR UPDATE;
 IF open IS DISTINCT FROM true THEN RAISE EXCEPTION 'Invoice is not a draft' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF NOT EXISTS (SELECT 1 FROM "DeliveryNote" WHERE id=NEW."deliveryNoteId" AND "organizationId"=org AND status='CONFIRMED') THEN
  RAISE EXCEPTION 'Only confirmed delivery notes can be invoiced' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER invoice_link_guard BEFORE INSERT OR UPDATE OR DELETE ON "InvoiceDeliveryNote" FOR EACH ROW EXECUTE FUNCTION maxbio_invoice_link_guard();

-- La línea copia exactamente la línea del Remito confirmado; solo descripción, precio e IVA cambian.
CREATE FUNCTION maxbio_invoice_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE iid uuid; org uuid; open boolean; src "DeliveryNoteLine";
BEGIN
 IF TG_OP='DELETE' THEN iid:=OLD."invoiceId"; org:=OLD."organizationId"; ELSE iid:=NEW."invoiceId"; org:=NEW."organizationId"; END IF;
 IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW."organizationId"<>OLD."organizationId" OR NEW."invoiceId"<>OLD."invoiceId" OR NEW."deliveryNoteId"<>OLD."deliveryNoteId" OR NEW."deliveryNoteLineId"<>OLD."deliveryNoteLineId" OR NEW."productId"<>OLD."productId" OR NEW.ordinal<>OLD.ordinal OR NEW.quantity<>OLD.quantity OR NEW."unitOfMeasure"<>OLD."unitOfMeasure" OR NEW."productNameSnapshot"<>OLD."productNameSnapshot" OR NEW."presentationSnapshot" IS DISTINCT FROM OLD."presentationSnapshot") THEN
  RAISE EXCEPTION 'Invoice line source is immutable' USING ERRCODE='23514';
 END IF;
 SELECT status='DRAFT' INTO open FROM "Invoice" WHERE id=iid AND "organizationId"=org FOR UPDATE;
 IF open IS DISTINCT FROM true THEN RAISE EXCEPTION 'Invoice is not a draft' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO src FROM "DeliveryNoteLine" WHERE id=NEW."deliveryNoteLineId" AND "organizationId"=org;
  IF src.quantity IS DISTINCT FROM NEW.quantity OR src."unitOfMeasureSnapshot" IS DISTINCT FROM NEW."unitOfMeasure" OR src."productNameSnapshot" IS DISTINCT FROM NEW."productNameSnapshot" OR src."presentationSnapshot" IS DISTINCT FROM NEW."presentationSnapshot" THEN
   RAISE EXCEPTION 'Invoice line must copy its delivery note line' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER invoice_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "InvoiceLine" FOR EACH ROW EXECUTE FUNCTION maxbio_invoice_line_guard();

-- Al commit: totales = suma de líneas, al menos un Remito, Remitos completos y READY completa.
CREATE FUNCTION maxbio_invoice_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE iid uuid; i "Invoice"; n numeric; v numeric;
BEGIN
 IF TG_TABLE_NAME='Invoice' THEN iid:=NEW.id; ELSIF TG_OP='DELETE' THEN iid:=OLD."invoiceId"; ELSE iid:=NEW."invoiceId"; END IF;
 SELECT * INTO i FROM "Invoice" WHERE id=iid;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT COALESCE(SUM("netAmount"),0), COALESCE(SUM("vatAmount"),0) INTO n, v FROM "InvoiceLine" WHERE "invoiceId"=iid AND "organizationId"=i."organizationId";
 IF i."netAmount"<>n OR i."vatAmount"<>v THEN RAISE EXCEPTION 'Invoice totals must equal its lines' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS (SELECT 1 FROM "InvoiceDeliveryNote" WHERE "invoiceId"=iid AND "organizationId"=i."organizationId") THEN
  RAISE EXCEPTION 'Invoice needs at least one delivery note' USING ERRCODE='23514';
 END IF;
 IF EXISTS (SELECT 1 FROM "InvoiceDeliveryNote" k JOIN "DeliveryNoteLine" l ON l."deliveryNoteId"=k."deliveryNoteId" AND l."organizationId"=k."organizationId"
  LEFT JOIN "InvoiceLine" x ON x."deliveryNoteLineId"=l.id AND x."invoiceId"=iid AND x."organizationId"=k."organizationId"
  WHERE k."invoiceId"=iid AND k."organizationId"=i."organizationId" AND x.id IS NULL) THEN
  RAISE EXCEPTION 'Delivery notes must be invoiced completely' USING ERRCODE='23514';
 END IF;
 IF i.status='READY' AND EXISTS (SELECT 1 FROM "InvoiceLine" WHERE "invoiceId"=iid AND "organizationId"=i."organizationId" AND "netAmount" IS NULL) THEN
  RAISE EXCEPTION 'Ready invoice needs priced lines' USING ERRCODE='23514';
 END IF;
 IF i.status='READY' AND i."invoiceType"='INVOICE_C' AND i."vatAmount"<>0 THEN
  RAISE EXCEPTION 'Invoice C does not itemize VAT' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER invoice_complete AFTER INSERT OR UPDATE ON "Invoice" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maxbio_invoice_complete();
CREATE CONSTRAINT TRIGGER invoice_line_complete AFTER INSERT OR UPDATE OR DELETE ON "InvoiceLine" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maxbio_invoice_complete();
CREATE CONSTRAINT TRIGGER invoice_link_complete AFTER INSERT OR DELETE ON "InvoiceDeliveryNote" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maxbio_invoice_complete();
