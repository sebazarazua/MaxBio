-- SQL CHECK accepts UNKNOWN: explicitly require both nullable lot fields together.
ALTER TABLE "InventoryLot" ADD CONSTRAINT inventory_lot_nullable_pair CHECK (("lotNumber" IS NULL) = ("normalizedLotNumber" IS NULL));
ALTER TABLE "InventoryReceiptLine" ADD CONSTRAINT inventory_receipt_series_quantity CHECK (jsonb_array_length("serialNumbers") = 0 OR quantity = jsonb_array_length("serialNumbers"));
ALTER TABLE "InventoryCountLine" ADD CONSTRAINT inventory_count_series_quantity CHECK (jsonb_array_length("serialNumbers") = 0 OR quantity = jsonb_array_length("serialNumbers"));
ALTER TABLE "InventoryMovement" ADD CONSTRAINT inventory_adjustment_reason CHECK (type <> 'ADJUSTMENT' OR (reason IN ('COUNT','ADMIN_ERROR','LOSS','DAMAGE_DISPOSAL','OTHER') AND length(btrim(notes)) > 0));
