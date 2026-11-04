ALTER TABLE "ArcaCredential" ADD COLUMN "certificateHolderCuit" VARCHAR(11);
UPDATE "ArcaCredential" SET "certificateHolderCuit" = "cuit";
ALTER TABLE "ArcaCredential" ADD CONSTRAINT "ArcaCredential_holder_cuit_format" CHECK ("certificateHolderCuit" IS NULL OR "certificateHolderCuit" ~ '^[0-9]{11}$');
