-- Both extensions ship with PostgreSQL and are trusted; no remote service or
-- dictionary configuration is required. GIN supports the token LIKE filters.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "Supplier_searchText_idx" ON "Supplier" USING GIN ("searchText" gin_trgm_ops);
CREATE INDEX "Product_searchText_idx" ON "Product" USING GIN ("searchText" gin_trgm_ops);
CREATE INDEX "SupplierCatalogItem_searchText_idx" ON "SupplierCatalogItem" USING GIN ("searchText" gin_trgm_ops);
