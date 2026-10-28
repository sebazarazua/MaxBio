-- Explicit NOT NULL is required: PostgreSQL CHECK accepts an UNKNOWN result.
-- Preserve the already-applied V3 migration and tighten the configuration tuple.
ALTER TABLE "ArcaIntegrationConfig" DROP CONSTRAINT wsfe_configuration_values;
ALTER TABLE "ArcaIntegrationConfig" ADD CONSTRAINT wsfe_configuration_values CHECK (
  ("pointOfSale" IS NULL AND "pointOfSaleCuit" IS NULL AND "pointOfSaleValidatedAt" IS NULL)
  OR
  ("pointOfSale" IS NOT NULL AND "pointOfSale" BETWEEN 1 AND 99999
   AND "pointOfSaleCuit" IS NOT NULL AND maxbio_valid_cuit("pointOfSaleCuit")
   AND "pointOfSaleValidatedAt" IS NOT NULL)
);
