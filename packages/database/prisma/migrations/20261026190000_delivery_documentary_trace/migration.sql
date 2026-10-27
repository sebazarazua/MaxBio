-- CreateEnum
CREATE TYPE "DeliveryTraceOrigin" AS ENUM ('INVENTORY', 'DECLARED');

-- CreateEnum
CREATE TYPE "DeliveryTraceCaptureMethod" AS ENUM ('MANUAL', 'GS1', 'LEGACY');

-- CreateTable
CREATE TABLE "DeliveryNoteLineTrace" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "deliveryNoteId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "lineId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "lotNumber" VARCHAR(128),
    "expirationDate" DATE,
    "serialNumber" VARCHAR(128),
    "inventoryAllocationId" UUID,
    "origin" "DeliveryTraceOrigin" NOT NULL,
    "captureMethod" "DeliveryTraceCaptureMethod" NOT NULL,
    "scannedGtinSnapshot" VARCHAR(14),
    "preserveOnUnlink" BOOLEAN NOT NULL DEFAULT false,
    "reviewedPriorTraceIds" UUID[] DEFAULT ARRAY[]::UUID[],

    CONSTRAINT "DeliveryNoteLineTrace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryNoteLineTrace_inventoryAllocationId_key" ON "DeliveryNoteLineTrace"("inventoryAllocationId");

-- CreateIndex
CREATE INDEX "DeliveryNoteLineTrace_organizationId_lineId_ordinal_idx" ON "DeliveryNoteLineTrace"("organizationId", "lineId", "ordinal");

-- CreateIndex
CREATE INDEX "DeliveryNoteLineTrace_organizationId_productId_lotNumber_idx" ON "DeliveryNoteLineTrace"("organizationId", "productId", "lotNumber");

-- CreateIndex
CREATE INDEX "DeliveryNoteLineTrace_organizationId_productId_serialNumber_idx" ON "DeliveryNoteLineTrace"("organizationId", "productId", "serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_trace_document_serial" ON "DeliveryNoteLineTrace"("organizationId", "deliveryNoteId", "productId", "serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_trace_line_scope" ON "DeliveryNoteLine"("organizationId", "deliveryNoteId", "productId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_trace_allocation_scope" ON "DeliveryNoteAllocation"("organizationId", "productId", "lineId", "id");

-- AddForeignKey
ALTER TABLE "DeliveryNoteLineTrace" ADD CONSTRAINT "DeliveryNoteLineTrace_organizationId_deliveryNoteId_produc_fkey" FOREIGN KEY ("organizationId", "deliveryNoteId", "productId", "lineId") REFERENCES "DeliveryNoteLine"("organizationId", "deliveryNoteId", "productId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DeliveryNoteLineTrace" ADD CONSTRAINT "DeliveryNoteLineTrace_organizationId_productId_lineId_inve_fkey" FOREIGN KEY ("organizationId", "productId", "lineId", "inventoryAllocationId") REFERENCES "DeliveryNoteAllocation"("organizationId", "productId", "lineId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Confirmed allocations must have a trustworthy historical source. Abort atomically otherwise.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM "DeliveryNoteAllocation" a JOIN "DeliveryNoteLine" l ON l.id=a."lineId"
 JOIN "DeliveryNote" d ON d.id=l."deliveryNoteId"
 LEFT JOIN "InventoryMovementLine" m ON m."deliveryAllocationId"=a.id
 LEFT JOIN "InventoryMovement" h ON h.id=m."movementId"
 WHERE d.status='CONFIRMED' AND (m.id IS NULL OR m."organizationId"<>a."organizationId" OR m."productId"<>a."productId" OR m."quantityDelta"<>-a.quantity OR h."deliveryNoteId" IS DISTINCT FROM d.id))
 THEN RAISE EXCEPTION 'Documentary trace backfill: inconsistent historical allocation'; END IF;
END $$;
INSERT INTO "DeliveryNoteLineTrace" (id,"organizationId","deliveryNoteId","productId","lineId",ordinal,quantity,"lotNumber","expirationDate","serialNumber","inventoryAllocationId",origin,"captureMethod")
SELECT a.id,a."organizationId",l."deliveryNoteId",a."productId",a."lineId",
 (row_number() OVER (PARTITION BY a."lineId" ORDER BY a.id)-1)::integer,a.quantity,
 CASE WHEN d.status='CONFIRMED' THEN m."lotNumber" ELSE lot."lotNumber" END,
 CASE WHEN d.status='CONFIRMED' THEN m."expirationDate" ELSE lot."expirationDate" END,
 CASE WHEN d.status='CONFIRMED' THEN m."serialNumber" ELSE ser."serialNumber" END,
 a.id,'INVENTORY','LEGACY'
FROM "DeliveryNoteAllocation" a JOIN "DeliveryNoteLine" l ON l.id=a."lineId"
JOIN "DeliveryNote" d ON d.id=l."deliveryNoteId"
JOIN "InventoryBalance" b ON b.id=a."positionId"
LEFT JOIN "InventoryLot" lot ON lot.id=b."lotId" LEFT JOIN "InventorySerial" ser ON ser.id=b."serialId"
LEFT JOIN "InventoryMovementLine" m ON m."deliveryAllocationId"=a.id;

ALTER TABLE "DeliveryNoteLineTrace" ADD CONSTRAINT delivery_trace_values CHECK (
 quantity>0 AND quantity<=1000000000.999999 AND ordinal>=0
 AND ((origin='INVENTORY')=("inventoryAllocationId" IS NOT NULL))
 AND (origin='INVENTORY' OR "lotNumber" IS NOT NULL OR "expirationDate" IS NOT NULL OR "serialNumber" IS NOT NULL OR "scannedGtinSnapshot" IS NOT NULL)
 AND ("serialNumber" IS NULL OR quantity=1)
 AND ("lotNumber" IS NULL OR (length("lotNumber")>0 AND "lotNumber"=btrim("lotNumber") AND "lotNumber" !~ '[[:cntrl:]]'))
 AND ("serialNumber" IS NULL OR (length("serialNumber")>0 AND "serialNumber"=btrim("serialNumber") AND "serialNumber" !~ '[[:cntrl:]]'))
 AND ("scannedGtinSnapshot" IS NULL OR (length("scannedGtinSnapshot")=14 AND maxbio_valid_gtin("scannedGtinSnapshot")))
 AND "reviewedPriorTraceIds" IS NOT NULL AND cardinality("reviewedPriorTraceIds")<=100
);
-- Reuses the parent locking/closed-document guard; prevents late insert, update and delete.
CREATE TRIGGER delivery_trace_guard BEFORE INSERT OR UPDATE OR DELETE ON "DeliveryNoteLineTrace"
 FOR EACH ROW EXECUTE FUNCTION maxbio_delivery_child_guard();

-- Aggregates span rows: checked at commit after atomic replacement/posting, not mid-command.
CREATE FUNCTION maxbio_delivery_trace_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r jsonb; did uuid; d "DeliveryNote";
BEGIN
 r:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF TG_TABLE_NAME='DeliveryNote' THEN did:=(r->>'id')::uuid;
 ELSIF TG_TABLE_NAME='DeliveryNoteLine' OR TG_TABLE_NAME='DeliveryNoteLineTrace' THEN did:=(r->>'deliveryNoteId')::uuid;
 ELSE SELECT "deliveryNoteId" INTO did FROM "DeliveryNoteLine" WHERE id=(r->>'lineId')::uuid; END IF;
 SELECT * INTO d FROM "DeliveryNote" WHERE id=did;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF EXISTS (SELECT 1 FROM "DeliveryNoteLine" l WHERE l."deliveryNoteId"=did AND COALESCE((SELECT SUM(t.quantity) FROM "DeliveryNoteLineTrace" t WHERE t."lineId"=l.id),0)>l.quantity)
 THEN RAISE EXCEPTION 'Physical trace exceeds document quantity' USING ERRCODE='23514'; END IF;
 IF EXISTS (SELECT 1 FROM "DeliveryNoteAllocation" a JOIN "DeliveryNoteLine" l ON l.id=a."lineId" LEFT JOIN "DeliveryNoteLineTrace" t ON t."inventoryAllocationId"=a.id
 WHERE l."deliveryNoteId"=did AND (t.id IS NULL OR t.quantity<>a.quantity))
 THEN RAISE EXCEPTION 'Allocation requires exactly one equal trace' USING ERRCODE='23514'; END IF;
 IF EXISTS (SELECT 1 FROM "DeliveryNoteLineTrace" t JOIN "Product" p ON p.id=t."productId"
 WHERE t."deliveryNoteId"=did AND ((t."serialNumber" IS NOT NULL AND p."unitOfMeasure" NOT IN ('UNIT','PAIR')) OR (p."unitOfMeasure" IN ('UNIT','PAIR') AND t.quantity<>trunc(t.quantity))))
 THEN RAISE EXCEPTION 'Invalid physical trace unit' USING ERRCODE='23514'; END IF;
 IF EXISTS (SELECT 1 FROM "DeliveryNoteLineTrace" t JOIN "DeliveryNoteAllocation" a ON a.id=t."inventoryAllocationId"
 JOIN "InventoryBalance" b ON b.id=a."positionId" LEFT JOIN "InventoryLot" lot ON lot.id=b."lotId" LEFT JOIN "InventorySerial" ser ON ser.id=b."serialId"
 LEFT JOIN "InventoryMovementLine" m ON m."deliveryAllocationId"=a.id
 WHERE t."deliveryNoteId"=did AND (
 (t."lotNumber",t."expirationDate",t."serialNumber") IS DISTINCT FROM
 (CASE WHEN d.status='CONFIRMED' THEN m."lotNumber" ELSE lot."lotNumber" END,
 CASE WHEN d.status='CONFIRMED' THEN m."expirationDate" ELSE lot."expirationDate" END,
 CASE WHEN d.status='CONFIRMED' THEN m."serialNumber" ELSE ser."serialNumber" END)))
 THEN RAISE EXCEPTION 'Inventory trace must match its physical source' USING ERRCODE='23514'; END IF;
 IF d.status='CONFIRMED' AND EXISTS (SELECT 1 FROM "DeliveryNoteLineTrace" t WHERE t."deliveryNoteId"=did AND t."scannedGtinSnapshot" IS NOT NULL AND NOT EXISTS
 (SELECT 1 FROM "ProductIdentifier" i WHERE i."organizationId"=t."organizationId" AND i."productId"=t."productId" AND i.kind='GTIN' AND i."normalizedValue"=t."scannedGtinSnapshot" AND i."archivedAt" IS NULL))
 THEN RAISE EXCEPTION 'Observed GTIN does not identify this product' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER delivery_trace_complete AFTER INSERT OR UPDATE OR DELETE ON "DeliveryNoteLineTrace" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maxbio_delivery_trace_complete();
CREATE CONSTRAINT TRIGGER delivery_trace_line_complete AFTER INSERT OR UPDATE OR DELETE ON "DeliveryNoteLine" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maxbio_delivery_trace_complete();
CREATE CONSTRAINT TRIGGER delivery_trace_allocation_complete AFTER INSERT OR UPDATE OR DELETE ON "DeliveryNoteAllocation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maxbio_delivery_trace_complete();
CREATE CONSTRAINT TRIGGER delivery_trace_document_complete AFTER INSERT OR UPDATE ON "DeliveryNote" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maxbio_delivery_trace_complete();
-- Run aggregate validation for backfilled rows as well; no historical document mutation.
DO $$ DECLARE x record; BEGIN
 FOR x IN SELECT "deliveryNoteId" FROM "DeliveryNoteLineTrace" GROUP BY "deliveryNoteId" LOOP
  IF EXISTS (SELECT 1 FROM "DeliveryNoteLine" l WHERE l."deliveryNoteId"=x."deliveryNoteId" AND (SELECT SUM(quantity) FROM "DeliveryNoteLineTrace" WHERE "lineId"=l.id)>l.quantity)
  THEN RAISE EXCEPTION 'Documentary trace backfill: invalid coverage'; END IF;
 END LOOP;
END $$;
