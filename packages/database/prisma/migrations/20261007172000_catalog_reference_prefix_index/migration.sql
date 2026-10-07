-- Use the operator class corresponding to the varchar reference column.
-- Keep the previously applied migrations immutable.
DROP INDEX "SupplierCatalogItem_reference_prefix_idx";
CREATE INDEX "SupplierCatalogItem_reference_prefix_idx"
ON "SupplierCatalogItem" ("organizationId", "internalReferenceCode" varchar_pattern_ops);
