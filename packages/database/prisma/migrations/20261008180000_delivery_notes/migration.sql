-- AlterTable
ALTER TABLE "InventoryMovement" ADD COLUMN     "deliveryNoteId" UUID;

-- AlterTable
ALTER TABLE "InventoryMovementLine" ADD COLUMN     "deliveryAllocationId" UUID;

-- CreateTable
CREATE TABLE "DeliveryNote" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "status" "InventoryDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "documentDate" DATE NOT NULL,
    "documentPrefix" VARCHAR(12),
    "documentNumber" VARCHAR(12),
    "patientName" VARCHAR(160),
    "affiliateNumber" VARCHAR(80),
    "notes" VARCHAR(1000),
    "customerSnapshot" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "confirmedAt" TIMESTAMPTZ(3),
    "confirmedByUserId" UUID,
    "confirmedByMembershipId" UUID,
    "creationHash" CHAR(64) NOT NULL,
    "confirmationOperationId" UUID,
    "requestHash" CHAR(64),

    CONSTRAINT "DeliveryNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryNoteLine" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "deliveryNoteId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "productNameSnapshot" VARCHAR(200),
    "presentationSnapshot" VARCHAR(200),
    "unitOfMeasureSnapshot" "UnitOfMeasure",
    "gtinSnapshot" VARCHAR(14),

    CONSTRAINT "DeliveryNoteLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryNoteAllocation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "lineId" UUID NOT NULL,
    "positionId" UUID NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,

    CONSTRAINT "DeliveryNoteAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryNote_organizationId_documentDate_id_idx" ON "DeliveryNote"("organizationId", "documentDate", "id");

-- CreateIndex
CREATE INDEX "DeliveryNote_organizationId_customerId_idx" ON "DeliveryNote"("organizationId", "customerId");

-- CreateIndex
CREATE INDEX "DeliveryNote_organizationId_status_createdAt_id_idx" ON "DeliveryNote"("organizationId", "status", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryNote_organizationId_id_key" ON "DeliveryNote"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryNote_organizationId_documentPrefix_documentNumber_key" ON "DeliveryNote"("organizationId", "documentPrefix", "documentNumber");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryNote_organizationId_confirmationOperationId_key" ON "DeliveryNote"("organizationId", "confirmationOperationId");

-- CreateIndex
CREATE INDEX "DeliveryNoteLine_organizationId_deliveryNoteId_ordinal_idx" ON "DeliveryNoteLine"("organizationId", "deliveryNoteId", "ordinal");

-- CreateIndex
CREATE INDEX "DeliveryNoteLine_organizationId_productId_idx" ON "DeliveryNoteLine"("organizationId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryNoteLine_organizationId_productId_id_key" ON "DeliveryNoteLine"("organizationId", "productId", "id");

-- CreateIndex
CREATE INDEX "DeliveryNoteAllocation_organizationId_positionId_idx" ON "DeliveryNoteAllocation"("organizationId", "positionId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryNoteAllocation_organizationId_productId_id_key" ON "DeliveryNoteAllocation"("organizationId", "productId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryNoteAllocation_organizationId_lineId_positionId_key" ON "DeliveryNoteAllocation"("organizationId", "lineId", "positionId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryBalance_organizationId_productId_id_key" ON "InventoryBalance"("organizationId", "productId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryMovement_organizationId_deliveryNoteId_key" ON "InventoryMovement"("organizationId", "deliveryNoteId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryMovementLine_organizationId_productId_deliveryAllo_key" ON "InventoryMovementLine"("organizationId", "productId", "deliveryAllocationId");

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_organizationId_deliveryNoteId_fkey" FOREIGN KEY ("organizationId", "deliveryNoteId") REFERENCES "DeliveryNote"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryMovementLine" ADD CONSTRAINT "InventoryMovementLine_delivery_source_fkey" FOREIGN KEY ("organizationId", "productId", "deliveryAllocationId") REFERENCES "DeliveryNoteAllocation"("organizationId", "productId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DeliveryNote" ADD CONSTRAINT "DeliveryNote_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DeliveryNote" ADD CONSTRAINT "DeliveryNote_organizationId_customerId_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "Customer"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DeliveryNote" ADD CONSTRAINT "DeliveryNote_organizationId_confirmedByMembershipId_confir_fkey" FOREIGN KEY ("organizationId", "confirmedByMembershipId", "confirmedByUserId") REFERENCES "Membership"("organizationId", "id", "userId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DeliveryNoteLine" ADD CONSTRAINT "DeliveryNoteLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DeliveryNoteLine" ADD CONSTRAINT "DeliveryNoteLine_organizationId_deliveryNoteId_fkey" FOREIGN KEY ("organizationId", "deliveryNoteId") REFERENCES "DeliveryNote"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DeliveryNoteLine" ADD CONSTRAINT "DeliveryNoteLine_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DeliveryNoteAllocation" ADD CONSTRAINT "DeliveryNoteAllocation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DeliveryNoteAllocation" ADD CONSTRAINT "DeliveryNoteAllocation_organizationId_productId_lineId_fkey" FOREIGN KEY ("organizationId", "productId", "lineId") REFERENCES "DeliveryNoteLine"("organizationId", "productId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DeliveryNoteAllocation" ADD CONSTRAINT "DeliveryNoteAllocation_organizationId_productId_positionId_fkey" FOREIGN KEY ("organizationId", "productId", "positionId") REFERENCES "InventoryBalance"("organizationId", "productId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Existing ledger protections stay in place. Only the typed source is extended.
ALTER TABLE "InventoryMovement" DROP CONSTRAINT inventory_movement_source;
ALTER TABLE "InventoryMovement" ADD CONSTRAINT inventory_movement_source CHECK (
 (type='RECEIPT' AND "receiptId" IS NOT NULL AND "countSessionId" IS NULL AND "deliveryNoteId" IS NULL AND "operationId" IS NULL) OR
 (type='INITIAL_COUNT' AND "countSessionId" IS NOT NULL AND "receiptId" IS NULL AND "deliveryNoteId" IS NULL AND "operationId" IS NULL) OR
 (type='ADJUSTMENT' AND "receiptId" IS NULL AND "countSessionId" IS NULL AND "deliveryNoteId" IS NULL AND "operationId" IS NOT NULL AND "requestHash" IS NOT NULL AND reason IS NOT NULL AND notes IS NOT NULL) OR
 (type='OUTBOUND' AND "deliveryNoteId" IS NOT NULL AND "receiptId" IS NULL AND "countSessionId" IS NULL AND "operationId" IS NULL));

ALTER TABLE "DeliveryNote" ADD CONSTRAINT delivery_number CHECK (("documentPrefix" IS NULL) = ("documentNumber" IS NULL) AND ("documentPrefix" IS NULL OR ("documentPrefix" ~ '^[0-9]{1,12}$' AND "documentNumber" ~ '^[0-9]{1,12}$')));
ALTER TABLE "DeliveryNote" ADD CONSTRAINT delivery_state CHECK (version > 0 AND
 ((status='CONFIRMED' AND "confirmedAt" IS NOT NULL AND "confirmedByUserId" IS NOT NULL AND "confirmedByMembershipId" IS NOT NULL AND "confirmationOperationId" IS NOT NULL AND "requestHash" IS NOT NULL AND "customerSnapshot" IS NOT NULL AND "documentNumber" IS NOT NULL) OR
 (status<>'CONFIRMED' AND "confirmedAt" IS NULL AND "confirmedByUserId" IS NULL AND "confirmedByMembershipId" IS NULL AND "confirmationOperationId" IS NULL AND "requestHash" IS NULL AND "customerSnapshot" IS NULL)));
ALTER TABLE "DeliveryNoteLine" ADD CONSTRAINT delivery_line_quantity CHECK (quantity > 0 AND quantity <= 1000000000.999999 AND ordinal >= 0);
ALTER TABLE "DeliveryNoteAllocation" ADD CONSTRAINT delivery_allocation_quantity CHECK (quantity > 0 AND quantity <= 1000000000.999999);

CREATE FUNCTION maxbio_delivery_document_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status<>'DRAFT' OR NEW.id<>OLD.id OR NEW."organizationId"<>OLD."organizationId" OR NEW."creationHash"<>OLD."creationHash" OR NEW."createdAt"<>OLD."createdAt" THEN
  RAISE EXCEPTION 'Delivery document is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER delivery_document_guard BEFORE UPDATE OR DELETE ON "DeliveryNote" FOR EACH ROW EXECUTE FUNCTION maxbio_delivery_document_guard();

CREATE FUNCTION maxbio_delivery_child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r jsonb; did uuid; open boolean;
BEGIN
 r:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF TG_OP='UPDATE' AND ((to_jsonb(OLD)->>'id') IS DISTINCT FROM (r->>'id') OR (to_jsonb(OLD)->>'organizationId') IS DISTINCT FROM (r->>'organizationId') OR (to_jsonb(OLD)->>'productId') IS DISTINCT FROM (r->>'productId') OR (to_jsonb(OLD)->>'lineId') IS DISTINCT FROM (r->>'lineId') OR (to_jsonb(OLD)->>'deliveryNoteId') IS DISTINCT FROM (r->>'deliveryNoteId')) THEN RAISE EXCEPTION 'Delivery child identity is immutable' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='DeliveryNoteLine' THEN did:=(r->>'deliveryNoteId')::uuid;
 ELSE SELECT "deliveryNoteId" INTO did FROM "DeliveryNoteLine" WHERE id=(r->>'lineId')::uuid AND "organizationId"=(r->>'organizationId')::uuid; END IF;
 SELECT status='DRAFT' INTO open FROM "DeliveryNote" WHERE id=did AND "organizationId"=(r->>'organizationId')::uuid FOR UPDATE;
 IF open IS DISTINCT FROM true THEN RAISE EXCEPTION 'Delivery document is closed' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER delivery_line_guard BEFORE INSERT OR UPDATE OR DELETE ON "DeliveryNoteLine" FOR EACH ROW EXECUTE FUNCTION maxbio_delivery_child_guard();
CREATE TRIGGER delivery_allocation_guard BEFORE INSERT OR UPDATE OR DELETE ON "DeliveryNoteAllocation" FOR EACH ROW EXECUTE FUNCTION maxbio_delivery_child_guard();

-- Both directions checked at commit, after posting and document sealing.
CREATE FUNCTION maxbio_delivery_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE did uuid; d "DeliveryNote"; m "InventoryMovement";
BEGIN
 IF TG_TABLE_NAME='DeliveryNote' THEN did:=NEW.id; ELSE did:=NEW."deliveryNoteId"; END IF;
 IF did IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO d FROM "DeliveryNote" WHERE id=did;
 SELECT * INTO m FROM "InventoryMovement" WHERE "deliveryNoteId"=did AND "organizationId"=d."organizationId";
 IF (d.status='CONFIRMED') IS DISTINCT FROM (m.id IS NOT NULL) THEN RAISE EXCEPTION 'Delivery and movement must be confirmed together' USING ERRCODE='23514'; END IF;
 IF d.status='CONFIRMED' THEN
  IF m.type<>'OUTBOUND' OR m."postedAt" IS NULL OR NOT EXISTS (SELECT 1 FROM "DeliveryNoteLine" WHERE "deliveryNoteId"=did) THEN RAISE EXCEPTION 'Incomplete delivery' USING ERRCODE='23514'; END IF;
  IF EXISTS (SELECT 1 FROM "DeliveryNoteLine" l WHERE l."deliveryNoteId"=did AND (l."productNameSnapshot" IS NULL OR l."unitOfMeasureSnapshot" IS NULL OR l.quantity IS DISTINCT FROM (SELECT SUM(a.quantity) FROM "DeliveryNoteAllocation" a WHERE a."lineId"=l.id))) THEN RAISE EXCEPTION 'Incomplete delivery allocations or snapshots' USING ERRCODE='23514'; END IF;
  IF EXISTS (SELECT 1 FROM "DeliveryNoteAllocation" a JOIN "DeliveryNoteLine" l ON l.id=a."lineId" LEFT JOIN "InventoryMovementLine" ml ON ml."deliveryAllocationId"=a.id AND ml."movementId"=m.id WHERE l."deliveryNoteId"=did AND (ml.id IS NULL OR ml."quantityDelta"<>-a.quantity)) THEN RAISE EXCEPTION 'Incomplete outbound trace' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER delivery_complete AFTER INSERT OR UPDATE ON "DeliveryNote" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maxbio_delivery_complete();
CREATE CONSTRAINT TRIGGER delivery_movement_complete AFTER INSERT ON "InventoryMovement" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maxbio_delivery_complete();

-- A referenced position retains its physical identity; rebuilding may only change quantity.
CREATE FUNCTION maxbio_delivery_position_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM "DeliveryNoteAllocation" WHERE "positionId"=OLD.id) AND (TG_OP='DELETE' OR (to_jsonb(OLD)-'quantity') IS DISTINCT FROM (to_jsonb(NEW)-'quantity')) THEN RAISE EXCEPTION 'Allocated position identity is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER delivery_position_guard BEFORE UPDATE OR DELETE ON "InventoryBalance" FOR EACH ROW EXECUTE FUNCTION maxbio_delivery_position_guard();
CREATE OR REPLACE FUNCTION maxbio_inventory_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m "InventoryMovement"; pol "ProductInventoryPolicy"; u "UnitOfMeasure";
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Inventory lines are immutable' USING ERRCODE='23514'; END IF;
 SELECT * INTO m FROM "InventoryMovement" WHERE id=NEW."movementId" AND "organizationId"=NEW."organizationId" FOR UPDATE;
 IF NOT FOUND OR m."postedAt" IS NOT NULL THEN RAISE EXCEPTION 'Inventory movement is closed' USING ERRCODE='23514'; END IF;
 IF (m.type='RECEIPT' AND (NEW."quantityDelta"<=0 OR NEW."receiptLineId" IS NULL OR NEW."countLineId" IS NOT NULL)) OR
    (m.type='INITIAL_COUNT' AND (NEW."quantityDelta"<=0 OR NEW."countLineId" IS NULL OR NEW."receiptLineId" IS NOT NULL)) OR
    (m.type='ADJUSTMENT' AND (NEW."receiptLineId" IS NOT NULL OR NEW."countLineId" IS NOT NULL)) THEN
   RAISE EXCEPTION 'Invalid inventory line source' USING ERRCODE='23514';
 END IF;
 IF m.type='RECEIPT' AND NOT EXISTS (SELECT 1 FROM "InventoryReceiptLine" WHERE id=NEW."receiptLineId" AND "receiptId"=m."receiptId" AND "organizationId"=NEW."organizationId") THEN
  RAISE EXCEPTION 'Invalid receipt source' USING ERRCODE='23514';
 END IF;
 IF m.type='INITIAL_COUNT' AND NOT EXISTS (SELECT 1 FROM "InventoryCountLine" l JOIN "InventoryCountScope" s ON s.id=l."scopeId" WHERE l.id=NEW."countLineId" AND s."sessionId"=m."countSessionId" AND l."organizationId"=NEW."organizationId") THEN
  RAISE EXCEPTION 'Invalid count source' USING ERRCODE='23514';
 END IF;
 IF (m.type<>'OUTBOUND' AND NEW."deliveryAllocationId" IS NOT NULL) OR
 (m.type='OUTBOUND' AND (NEW."deliveryAllocationId" IS NULL OR NEW."quantityDelta">=0 OR NEW."receiptLineId" IS NOT NULL OR NEW."countLineId" IS NOT NULL OR NEW.condition<>'USABLE')) THEN RAISE EXCEPTION 'Invalid outbound source' USING ERRCODE='23514'; END IF;
 IF m.type='OUTBOUND' AND NOT EXISTS (
  SELECT 1 FROM "DeliveryNoteAllocation" a JOIN "DeliveryNoteLine" l ON l.id=a."lineId" JOIN "InventoryBalance" b ON b.id=a."positionId"
  LEFT JOIN "InventoryLot" lot ON lot.id=b."lotId"
  WHERE a.id=NEW."deliveryAllocationId" AND l."deliveryNoteId"=m."deliveryNoteId" AND a."organizationId"=NEW."organizationId"
   AND b."productId"=NEW."productId" AND b."locationId"=NEW."locationId" AND b."lotId" IS NOT DISTINCT FROM NEW."lotId" AND b."serialId" IS NOT DISTINCT FROM NEW."serialId" AND b.condition=NEW.condition AND a.quantity=-NEW."quantityDelta"
   AND (lot."expirationDate" IS NULL OR lot."expirationDate">=(clock_timestamp() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)
 ) THEN RAISE EXCEPTION 'Invalid outbound physical identity' USING ERRCODE='23514'; END IF;
 SELECT * INTO pol FROM "ProductInventoryPolicy" WHERE "organizationId"=NEW."organizationId" AND "productId"=NEW."productId";
 SELECT "unitOfMeasure" INTO u FROM "Product" WHERE "organizationId"=NEW."organizationId" AND id=NEW."productId";
 IF pol.id IS NULL OR u IS DISTINCT FROM NEW."unitOfMeasure" OR
    (pol."serialRequired" AND (NEW."serialId" IS NULL OR u NOT IN ('UNIT','PAIR'))) OR
    (NOT pol."serialRequired" AND NEW."serialId" IS NOT NULL) OR
    (pol."lotRequired" AND NOT EXISTS (SELECT 1 FROM "InventoryLot" WHERE id=NEW."lotId" AND "lotNumber" IS NOT NULL)) OR
    (pol."expirationRequired" AND NOT EXISTS (SELECT 1 FROM "InventoryLot" WHERE id=NEW."lotId" AND "expirationDate" IS NOT NULL)) THEN
  RAISE EXCEPTION 'Invalid inventory tracking policy' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
