-- DeliveryNote is commercial documentation; only selected allocations participate in Inventory.
-- Keep the existing deferred triggers, unique source and immutable ledger guards.
CREATE OR REPLACE FUNCTION maxbio_delivery_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE did uuid; d "DeliveryNote"; m "InventoryMovement"; allocated boolean;
BEGIN
 IF TG_TABLE_NAME='DeliveryNote' THEN did:=NEW.id; ELSE did:=NEW."deliveryNoteId"; END IF;
 IF did IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO d FROM "DeliveryNote" WHERE id=did;
 SELECT * INTO m FROM "InventoryMovement" WHERE "deliveryNoteId"=did AND "organizationId"=d."organizationId";
 SELECT EXISTS (SELECT 1 FROM "DeliveryNoteAllocation" a JOIN "DeliveryNoteLine" l ON l.id=a."lineId" WHERE l."deliveryNoteId"=did) INTO allocated;
 IF (m.id IS NOT NULL AND d.status<>'CONFIRMED') OR
    (d.status='CONFIRMED' AND allocated IS DISTINCT FROM (m.id IS NOT NULL)) THEN
  RAISE EXCEPTION 'Delivery movement must match selected allocations' USING ERRCODE='23514';
 END IF;
 IF d.status='CONFIRMED' THEN
  IF NOT EXISTS (SELECT 1 FROM "DeliveryNoteLine" WHERE "deliveryNoteId"=did) OR
     (m.id IS NOT NULL AND (m.type<>'OUTBOUND' OR m."postedAt" IS NULL)) THEN
   RAISE EXCEPTION 'Incomplete delivery' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "DeliveryNoteLine" l WHERE l."deliveryNoteId"=did AND
    (l."productNameSnapshot" IS NULL OR l."unitOfMeasureSnapshot" IS NULL OR
     COALESCE((SELECT SUM(a.quantity) FROM "DeliveryNoteAllocation" a WHERE a."lineId"=l.id),0)>l.quantity)) THEN
   RAISE EXCEPTION 'Invalid delivery allocations or snapshots' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "DeliveryNoteAllocation" a JOIN "DeliveryNoteLine" l ON l.id=a."lineId"
    LEFT JOIN "InventoryMovementLine" ml ON ml."deliveryAllocationId"=a.id AND ml."movementId"=m.id
    WHERE l."deliveryNoteId"=did AND (ml.id IS NULL OR ml."quantityDelta"<>-a.quantity)) THEN
   RAISE EXCEPTION 'Incomplete outbound trace' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NULL;
END $$;
