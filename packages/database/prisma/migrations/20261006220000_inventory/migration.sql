-- CreateEnum
CREATE TYPE "InventoryCondition" AS ENUM ('USABLE', 'DAMAGED', 'QUARANTINE');

-- CreateEnum
CREATE TYPE "InventoryDocumentStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InventoryMovementType" AS ENUM ('RECEIPT', 'INITIAL_COUNT', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "InventoryLocation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "InventoryLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductInventoryPolicy" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "lotRequired" BOOLEAN NOT NULL DEFAULT false,
    "expirationRequired" BOOLEAN NOT NULL DEFAULT false,
    "serialRequired" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ProductInventoryPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryLot" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "lotNumber" VARCHAR(128),
    "normalizedLotNumber" VARCHAR(128),
    "expirationDate" DATE,

    CONSTRAINT "InventoryLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventorySerial" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "serialNumber" VARCHAR(128) NOT NULL,
    "normalizedSerialNumber" VARCHAR(128) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventorySerial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryStockScope" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "initializedAt" TIMESTAMPTZ(3),
    "initialCountScopeId" UUID,
    "activeCountSessionId" UUID,

    CONSTRAINT "InventoryStockScope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryBalance" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "lotId" UUID,
    "serialId" UUID,
    "condition" "InventoryCondition" NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,

    CONSTRAINT "InventoryBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryReceipt" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "InventoryDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "notes" VARCHAR(1000),
    "confirmationOperationId" UUID,
    "requestHash" CHAR(64),
    "confirmedAt" TIMESTAMPTZ(3),
    "supplierId" UUID NOT NULL,

    CONSTRAINT "InventoryReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryCountSession" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "InventoryDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "notes" VARCHAR(1000),
    "confirmationOperationId" UUID,
    "requestHash" CHAR(64),
    "confirmedAt" TIMESTAMPTZ(3),

    CONSTRAINT "InventoryCountSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryReceiptLine" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "lotNumber" VARCHAR(128),
    "lotId" UUID,
    "expirationDate" DATE,
    "serialNumbers" JSONB NOT NULL DEFAULT '[]',
    "condition" "InventoryCondition" NOT NULL DEFAULT 'USABLE',
    "policyVersion" INTEGER NOT NULL,
    "unitOfMeasure" "UnitOfMeasure" NOT NULL,
    "productName" VARCHAR(200) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receiptId" UUID NOT NULL,

    CONSTRAINT "InventoryReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryCountScope" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "expectedScopeVersion" INTEGER NOT NULL,
    "coverageConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMPTZ(3),

    CONSTRAINT "InventoryCountScope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryCountLine" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "quantity" DECIMAL(20,6) NOT NULL,
    "lotNumber" VARCHAR(128),
    "lotId" UUID,
    "expirationDate" DATE,
    "serialNumbers" JSONB NOT NULL DEFAULT '[]',
    "condition" "InventoryCondition" NOT NULL DEFAULT 'USABLE',
    "policyVersion" INTEGER NOT NULL,
    "unitOfMeasure" "UnitOfMeasure" NOT NULL,
    "productName" VARCHAR(200) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scopeId" UUID NOT NULL,

    CONSTRAINT "InventoryCountLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryMovement" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "type" "InventoryMovementType" NOT NULL,
    "reason" VARCHAR(40),
    "notes" VARCHAR(1000),
    "operationId" UUID,
    "requestHash" CHAR(64),
    "receiptId" UUID,
    "countSessionId" UUID,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postedAt" TIMESTAMPTZ(3),

    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryMovementLine" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "lotId" UUID,
    "serialId" UUID,
    "condition" "InventoryCondition" NOT NULL,
    "movementId" UUID NOT NULL,
    "quantityDelta" DECIMAL(20,6) NOT NULL,
    "unitOfMeasure" "UnitOfMeasure" NOT NULL,
    "productName" VARCHAR(200) NOT NULL,
    "gtin" VARCHAR(14),
    "lotNumber" VARCHAR(128),
    "expirationDate" DATE,
    "serialNumber" VARCHAR(128),
    "receiptLineId" UUID,
    "countLineId" UUID,

    CONSTRAINT "InventoryMovementLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLocation_organizationId_id_key" ON "InventoryLocation"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLocation_organizationId_code_key" ON "InventoryLocation"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ProductInventoryPolicy_organizationId_productId_key" ON "ProductInventoryPolicy"("organizationId", "productId");

-- CreateIndex
CREATE INDEX "InventoryLot_organizationId_expirationDate_id_idx" ON "InventoryLot"("organizationId", "expirationDate", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLot_organizationId_productId_id_key" ON "InventoryLot"("organizationId", "productId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLot_organizationId_productId_normalizedLotNumber_key" ON "InventoryLot"("organizationId", "productId", "normalizedLotNumber");

-- CreateIndex
CREATE UNIQUE INDEX "InventorySerial_organizationId_productId_id_key" ON "InventorySerial"("organizationId", "productId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InventorySerial_organizationId_productId_normalizedSerialNu_key" ON "InventorySerial"("organizationId", "productId", "normalizedSerialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryStockScope_organizationId_productId_locationId_key" ON "InventoryStockScope"("organizationId", "productId", "locationId");

-- CreateIndex
CREATE INDEX "InventoryBalance_organizationId_productId_locationId_idx" ON "InventoryBalance"("organizationId", "productId", "locationId");

-- CreateIndex
CREATE INDEX "InventoryBalance_organizationId_lotId_idx" ON "InventoryBalance"("organizationId", "lotId");

-- CreateIndex
CREATE INDEX "InventoryBalance_organizationId_serialId_idx" ON "InventoryBalance"("organizationId", "serialId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryBalance_organizationId_id_key" ON "InventoryBalance"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryBalance_position_key" ON "InventoryBalance"("organizationId", "productId", "locationId", "lotId", "serialId", "condition") NULLS NOT DISTINCT;

-- CreateIndex
CREATE INDEX "InventoryReceipt_organizationId_actorUserId_createdAt_id_idx" ON "InventoryReceipt"("organizationId", "actorUserId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryReceipt_organizationId_id_key" ON "InventoryReceipt"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryReceipt_organizationId_locationId_id_key" ON "InventoryReceipt"("organizationId", "locationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryReceipt_organizationId_confirmationOperationId_key" ON "InventoryReceipt"("organizationId", "confirmationOperationId");

-- CreateIndex
CREATE INDEX "InventoryCountSession_organizationId_actorUserId_createdAt__idx" ON "InventoryCountSession"("organizationId", "actorUserId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryCountSession_organizationId_id_key" ON "InventoryCountSession"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryCountSession_organizationId_locationId_id_key" ON "InventoryCountSession"("organizationId", "locationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryCountSession_organizationId_confirmationOperationI_key" ON "InventoryCountSession"("organizationId", "confirmationOperationId");

-- CreateIndex
CREATE INDEX "InventoryReceiptLine_organizationId_receiptId_createdAt_id_idx" ON "InventoryReceiptLine"("organizationId", "receiptId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryReceiptLine_organizationId_productId_locationId_id_key" ON "InventoryReceiptLine"("organizationId", "productId", "locationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryCountScope_organizationId_productId_locationId_id_key" ON "InventoryCountScope"("organizationId", "productId", "locationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryCountScope_organizationId_sessionId_productId_loca_key" ON "InventoryCountScope"("organizationId", "sessionId", "productId", "locationId");

-- CreateIndex
CREATE INDEX "InventoryCountLine_organizationId_scopeId_createdAt_id_idx" ON "InventoryCountLine"("organizationId", "scopeId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryCountLine_organizationId_productId_locationId_id_key" ON "InventoryCountLine"("organizationId", "productId", "locationId", "id");

-- CreateIndex
CREATE INDEX "InventoryMovement_organizationId_recordedAt_id_idx" ON "InventoryMovement"("organizationId", "recordedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryMovement_organizationId_id_key" ON "InventoryMovement"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryMovement_organizationId_receiptId_key" ON "InventoryMovement"("organizationId", "receiptId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryMovement_organizationId_countSessionId_key" ON "InventoryMovement"("organizationId", "countSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryMovement_organizationId_operationId_key" ON "InventoryMovement"("organizationId", "operationId");

-- CreateIndex
CREATE INDEX "InventoryMovementLine_organizationId_productId_movementId_i_idx" ON "InventoryMovementLine"("organizationId", "productId", "movementId", "id");

-- CreateIndex
CREATE INDEX "InventoryMovementLine_organizationId_lotId_movementId_idx" ON "InventoryMovementLine"("organizationId", "lotId", "movementId");

-- CreateIndex
CREATE INDEX "InventoryMovementLine_organizationId_serialId_movementId_idx" ON "InventoryMovementLine"("organizationId", "serialId", "movementId");

-- AddForeignKey
ALTER TABLE "InventoryLocation" ADD CONSTRAINT "InventoryLocation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductInventoryPolicy" ADD CONSTRAINT "ProductInventoryPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductInventoryPolicy" ADD CONSTRAINT "ProductInventoryPolicy_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryLot" ADD CONSTRAINT "InventoryLot_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryLot" ADD CONSTRAINT "InventoryLot_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventorySerial" ADD CONSTRAINT "InventorySerial_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventorySerial" ADD CONSTRAINT "InventorySerial_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryStockScope" ADD CONSTRAINT "InventoryStockScope_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryStockScope" ADD CONSTRAINT "InventoryStockScope_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryStockScope" ADD CONSTRAINT "InventoryStockScope_organizationId_locationId_fkey" FOREIGN KEY ("organizationId", "locationId") REFERENCES "InventoryLocation"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryStockScope" ADD CONSTRAINT "InventoryStockScope_organizationId_productId_locationId_in_fkey" FOREIGN KEY ("organizationId", "productId", "locationId", "initialCountScopeId") REFERENCES "InventoryCountScope"("organizationId", "productId", "locationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryStockScope" ADD CONSTRAINT "InventoryStockScope_organizationId_locationId_activeCountS_fkey" FOREIGN KEY ("organizationId", "locationId", "activeCountSessionId") REFERENCES "InventoryCountSession"("organizationId", "locationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryBalance" ADD CONSTRAINT "InventoryBalance_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryBalance" ADD CONSTRAINT "InventoryBalance_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryBalance" ADD CONSTRAINT "InventoryBalance_organizationId_locationId_fkey" FOREIGN KEY ("organizationId", "locationId") REFERENCES "InventoryLocation"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryBalance" ADD CONSTRAINT "InventoryBalance_organizationId_productId_lotId_fkey" FOREIGN KEY ("organizationId", "productId", "lotId") REFERENCES "InventoryLot"("organizationId", "productId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryBalance" ADD CONSTRAINT "InventoryBalance_organizationId_productId_serialId_fkey" FOREIGN KEY ("organizationId", "productId", "serialId") REFERENCES "InventorySerial"("organizationId", "productId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryReceipt" ADD CONSTRAINT "InventoryReceipt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryReceipt" ADD CONSTRAINT "InventoryReceipt_organizationId_locationId_fkey" FOREIGN KEY ("organizationId", "locationId") REFERENCES "InventoryLocation"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryReceipt" ADD CONSTRAINT "InventoryReceipt_organizationId_membershipId_actorUserId_fkey" FOREIGN KEY ("organizationId", "membershipId", "actorUserId") REFERENCES "Membership"("organizationId", "id", "userId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryReceipt" ADD CONSTRAINT "InventoryReceipt_sessionId_actorUserId_fkey" FOREIGN KEY ("sessionId", "actorUserId") REFERENCES "Session"("id", "userId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryReceipt" ADD CONSTRAINT "InventoryReceipt_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryCountSession" ADD CONSTRAINT "InventoryCountSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryCountSession" ADD CONSTRAINT "InventoryCountSession_organizationId_locationId_fkey" FOREIGN KEY ("organizationId", "locationId") REFERENCES "InventoryLocation"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryCountSession" ADD CONSTRAINT "InventoryCountSession_organizationId_membershipId_actorUse_fkey" FOREIGN KEY ("organizationId", "membershipId", "actorUserId") REFERENCES "Membership"("organizationId", "id", "userId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryCountSession" ADD CONSTRAINT "InventoryCountSession_sessionId_actorUserId_fkey" FOREIGN KEY ("sessionId", "actorUserId") REFERENCES "Session"("id", "userId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryReceiptLine" ADD CONSTRAINT "InventoryReceiptLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryReceiptLine" ADD CONSTRAINT "InventoryReceiptLine_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryReceiptLine" ADD CONSTRAINT "InventoryReceiptLine_organizationId_locationId_fkey" FOREIGN KEY ("organizationId", "locationId") REFERENCES "InventoryLocation"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryReceiptLine" ADD CONSTRAINT "InventoryReceiptLine_organizationId_locationId_receiptId_fkey" FOREIGN KEY ("organizationId", "locationId", "receiptId") REFERENCES "InventoryReceipt"("organizationId", "locationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryReceiptLine" ADD CONSTRAINT "InventoryReceiptLine_organizationId_productId_lotId_fkey" FOREIGN KEY ("organizationId", "productId", "lotId") REFERENCES "InventoryLot"("organizationId", "productId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryCountScope" ADD CONSTRAINT "InventoryCountScope_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryCountScope" ADD CONSTRAINT "InventoryCountScope_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryCountScope" ADD CONSTRAINT "InventoryCountScope_organizationId_locationId_fkey" FOREIGN KEY ("organizationId", "locationId") REFERENCES "InventoryLocation"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryCountScope" ADD CONSTRAINT "InventoryCountScope_organizationId_locationId_sessionId_fkey" FOREIGN KEY ("organizationId", "locationId", "sessionId") REFERENCES "InventoryCountSession"("organizationId", "locationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryCountLine" ADD CONSTRAINT "InventoryCountLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryCountLine" ADD CONSTRAINT "InventoryCountLine_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryCountLine" ADD CONSTRAINT "InventoryCountLine_organizationId_locationId_fkey" FOREIGN KEY ("organizationId", "locationId") REFERENCES "InventoryLocation"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryCountLine" ADD CONSTRAINT "InventoryCountLine_organizationId_productId_locationId_sco_fkey" FOREIGN KEY ("organizationId", "productId", "locationId", "scopeId") REFERENCES "InventoryCountScope"("organizationId", "productId", "locationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryCountLine" ADD CONSTRAINT "InventoryCountLine_organizationId_productId_lotId_fkey" FOREIGN KEY ("organizationId", "productId", "lotId") REFERENCES "InventoryLot"("organizationId", "productId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_organizationId_membershipId_actorUserId_fkey" FOREIGN KEY ("organizationId", "membershipId", "actorUserId") REFERENCES "Membership"("organizationId", "id", "userId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_sessionId_actorUserId_fkey" FOREIGN KEY ("sessionId", "actorUserId") REFERENCES "Session"("id", "userId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_organizationId_receiptId_fkey" FOREIGN KEY ("organizationId", "receiptId") REFERENCES "InventoryReceipt"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_organizationId_countSessionId_fkey" FOREIGN KEY ("organizationId", "countSessionId") REFERENCES "InventoryCountSession"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryMovementLine" ADD CONSTRAINT "InventoryMovementLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryMovementLine" ADD CONSTRAINT "InventoryMovementLine_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryMovementLine" ADD CONSTRAINT "InventoryMovementLine_organizationId_locationId_fkey" FOREIGN KEY ("organizationId", "locationId") REFERENCES "InventoryLocation"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryMovementLine" ADD CONSTRAINT "InventoryMovementLine_organizationId_productId_lotId_fkey" FOREIGN KEY ("organizationId", "productId", "lotId") REFERENCES "InventoryLot"("organizationId", "productId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryMovementLine" ADD CONSTRAINT "InventoryMovementLine_organizationId_productId_serialId_fkey" FOREIGN KEY ("organizationId", "productId", "serialId") REFERENCES "InventorySerial"("organizationId", "productId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryMovementLine" ADD CONSTRAINT "InventoryMovementLine_organizationId_movementId_fkey" FOREIGN KEY ("organizationId", "movementId") REFERENCES "InventoryMovement"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryMovementLine" ADD CONSTRAINT "InventoryMovementLine_receipt_source_fkey" FOREIGN KEY ("organizationId", "productId", "locationId", "receiptLineId") REFERENCES "InventoryReceiptLine"("organizationId", "productId", "locationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventoryMovementLine" ADD CONSTRAINT "InventoryMovementLine_count_source_fkey" FOREIGN KEY ("organizationId", "productId", "locationId", "countLineId") REFERENCES "InventoryCountLine"("organizationId", "productId", "locationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Additional invariants that Prisma cannot express.
CREATE UNIQUE INDEX "InventoryBalance_active_serial_key" ON "InventoryBalance" ("organizationId", "serialId") WHERE "serialId" IS NOT NULL AND quantity > 0;
CREATE UNIQUE INDEX "InventoryCountScope_initialized_key" ON "InventoryCountScope" ("organizationId", "productId", "locationId") WHERE "confirmedAt" IS NOT NULL;
ALTER TABLE "InventoryBalance" ADD CONSTRAINT inventory_balance_quantity CHECK (quantity >= 0 AND ("serialId" IS NULL OR quantity IN (0,1)));
ALTER TABLE "InventoryMovementLine" ADD CONSTRAINT inventory_line_quantity CHECK ("quantityDelta" <> 0 AND ("unitOfMeasure" NOT IN ('UNIT','PAIR') OR "quantityDelta" = trunc("quantityDelta")) AND ("serialId" IS NULL OR "quantityDelta" IN (-1,1)));
ALTER TABLE "InventoryLot" ADD CONSTRAINT inventory_lot_number CHECK (("lotNumber" IS NULL AND "normalizedLotNumber" IS NULL) OR ("lotNumber" IS NOT NULL AND "lotNumber" <> '' AND "lotNumber" = btrim("lotNumber") AND "normalizedLotNumber" = "lotNumber" AND "lotNumber" !~ '[[:cntrl:]]'));
ALTER TABLE "InventorySerial" ADD CONSTRAINT inventory_serial_number CHECK ("serialNumber" <> '' AND "serialNumber" = btrim("serialNumber") AND "normalizedSerialNumber" = "serialNumber" AND "serialNumber" !~ '[[:cntrl:]]');
ALTER TABLE "ProductInventoryPolicy" ADD CONSTRAINT inventory_policy_version CHECK (version > 0);
ALTER TABLE "InventoryStockScope" ADD CONSTRAINT inventory_scope_state CHECK (version > 0 AND (("initializedAt" IS NULL) = ("initialCountScopeId" IS NULL)));
ALTER TABLE "InventoryMovement" ADD CONSTRAINT inventory_movement_source CHECK (
 (type='RECEIPT' AND "receiptId" IS NOT NULL AND "countSessionId" IS NULL AND "operationId" IS NULL) OR
 (type='INITIAL_COUNT' AND "countSessionId" IS NOT NULL AND "receiptId" IS NULL AND "operationId" IS NULL) OR
 (type='ADJUSTMENT' AND "receiptId" IS NULL AND "countSessionId" IS NULL AND "operationId" IS NOT NULL AND "requestHash" IS NOT NULL AND reason IS NOT NULL AND notes IS NOT NULL));

CREATE FUNCTION maxbio_inventory_movement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Inventory ledger is immutable' USING ERRCODE='23514'; END IF;
 IF OLD."postedAt" IS NOT NULL OR NEW."postedAt" IS NULL OR (to_jsonb(NEW)-'postedAt') IS DISTINCT FROM (to_jsonb(OLD)-'postedAt') THEN
  RAISE EXCEPTION 'Inventory ledger is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_movement_immutable BEFORE UPDATE OR DELETE ON "InventoryMovement" FOR EACH ROW EXECUTE FUNCTION maxbio_inventory_movement_guard();

CREATE FUNCTION maxbio_inventory_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER inventory_line_immutable BEFORE INSERT OR UPDATE OR DELETE ON "InventoryMovementLine" FOR EACH ROW EXECUTE FUNCTION maxbio_inventory_line_guard();

CREATE FUNCTION maxbio_inventory_movement_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM "InventoryMovement" WHERE id=NEW.id AND "postedAt" IS NOT NULL) OR NOT EXISTS (SELECT 1 FROM "InventoryMovementLine" WHERE "movementId"=NEW.id) THEN
  RAISE EXCEPTION 'Incomplete inventory movement' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inventory_movement_complete AFTER INSERT ON "InventoryMovement" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maxbio_inventory_movement_complete();

CREATE FUNCTION maxbio_inventory_document_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'Inventory document is closed' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF NEW."organizationId"<>OLD."organizationId" OR NEW."actorUserId"<>OLD."actorUserId" OR NEW."locationId"<>OLD."locationId" THEN RAISE EXCEPTION 'Inventory document identity is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_receipt_closed BEFORE UPDATE OR DELETE ON "InventoryReceipt" FOR EACH ROW EXECUTE FUNCTION maxbio_inventory_document_guard();
CREATE TRIGGER inventory_count_closed BEFORE UPDATE OR DELETE ON "InventoryCountSession" FOR EACH ROW EXECUTE FUNCTION maxbio_inventory_document_guard();

CREATE FUNCTION maxbio_inventory_draft_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r jsonb; open boolean;
BEGIN
 r:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF TG_OP='UPDATE' AND ((to_jsonb(OLD)->>'organizationId') IS DISTINCT FROM (r->>'organizationId') OR (to_jsonb(OLD)->>'receiptId') IS DISTINCT FROM (r->>'receiptId') OR (to_jsonb(OLD)->>'scopeId') IS DISTINCT FROM (r->>'scopeId')) THEN RAISE EXCEPTION 'Inventory line identity is immutable' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='InventoryReceiptLine' THEN
  SELECT status='DRAFT' INTO open FROM "InventoryReceipt" WHERE id=(r->>'receiptId')::uuid AND "organizationId"=(r->>'organizationId')::uuid FOR UPDATE;
 ELSE
  SELECT c.status='DRAFT' INTO open FROM "InventoryCountSession" c JOIN "InventoryCountScope" s ON s."sessionId"=c.id WHERE s.id=(r->>'scopeId')::uuid AND c."organizationId"=(r->>'organizationId')::uuid FOR UPDATE OF c;
 END IF;
 IF open IS DISTINCT FROM true THEN RAISE EXCEPTION 'Inventory draft is closed' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_receipt_line_closed BEFORE INSERT OR UPDATE OR DELETE ON "InventoryReceiptLine" FOR EACH ROW EXECUTE FUNCTION maxbio_inventory_draft_line_guard();
CREATE TRIGGER inventory_count_line_closed BEFORE INSERT OR UPDATE OR DELETE ON "InventoryCountLine" FOR EACH ROW EXECUTE FUNCTION maxbio_inventory_draft_line_guard();

CREATE FUNCTION maxbio_inventory_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sid uuid;
BEGIN
 sid:=CASE WHEN TG_OP='INSERT' THEN NEW."sessionId" ELSE OLD."sessionId" END;
 IF NOT EXISTS (SELECT 1 FROM "InventoryCountSession" WHERE id=sid AND status='DRAFT') THEN RAISE EXCEPTION 'Count scope is closed' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_count_scope_closed BEFORE INSERT OR UPDATE OR DELETE ON "InventoryCountScope" FOR EACH ROW EXECUTE FUNCTION maxbio_inventory_scope_guard();

CREATE FUNCTION maxbio_inventory_product_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."unitOfMeasure"<>OLD."unitOfMeasure" AND (EXISTS (SELECT 1 FROM "InventoryMovementLine" WHERE "organizationId"=OLD."organizationId" AND "productId"=OLD.id) OR EXISTS (SELECT 1 FROM "InventoryCountScope" WHERE "organizationId"=OLD."organizationId" AND "productId"=OLD.id AND "confirmedAt" IS NOT NULL)) THEN RAISE EXCEPTION 'Product unit has inventory history' USING ERRCODE='23514'; END IF;
 IF NEW."archivedAt" IS NOT NULL AND OLD."archivedAt" IS NULL AND (EXISTS (SELECT 1 FROM "InventoryBalance" WHERE "organizationId"=OLD."organizationId" AND "productId"=OLD.id AND quantity>0) OR EXISTS (SELECT 1 FROM "InventoryStockScope" WHERE "organizationId"=OLD."organizationId" AND "productId"=OLD.id AND "activeCountSessionId" IS NOT NULL)) THEN RAISE EXCEPTION 'Product has stock or active count' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_product_guard BEFORE UPDATE ON "Product" FOR EACH ROW EXECUTE FUNCTION maxbio_inventory_product_guard();

CREATE FUNCTION maxbio_inventory_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM "InventoryMovementLine" WHERE "organizationId"=OLD."organizationId" AND "productId"=OLD."productId") OR EXISTS (SELECT 1 FROM "InventoryCountScope" WHERE "organizationId"=OLD."organizationId" AND "productId"=OLD."productId" AND "confirmedAt" IS NOT NULL) THEN
  RAISE EXCEPTION 'Inventory policy has confirmed history' USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_policy_guard BEFORE UPDATE OR DELETE ON "ProductInventoryPolicy" FOR EACH ROW EXECUTE FUNCTION maxbio_inventory_policy_guard();

CREATE FUNCTION maxbio_inventory_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Inventory physical identity requires administrative correction' USING ERRCODE='23514';
END $$;
CREATE TRIGGER inventory_lot_guard BEFORE UPDATE OR DELETE ON "InventoryLot" FOR EACH ROW EXECUTE FUNCTION maxbio_inventory_identity_guard();
CREATE TRIGGER inventory_serial_guard BEFORE UPDATE OR DELETE ON "InventorySerial" FOR EACH ROW EXECUTE FUNCTION maxbio_inventory_identity_guard();

ALTER TABLE "InventoryReceiptLine" ADD CONSTRAINT inventoryreceiptline_quantity CHECK (quantity >= 0.000001 AND ("unitOfMeasure" NOT IN ('UNIT','PAIR') OR quantity=trunc(quantity)) AND jsonb_typeof("serialNumbers")='array' AND "policyVersion">0);

ALTER TABLE "InventoryCountLine" ADD CONSTRAINT inventorycountline_quantity CHECK (quantity >= 0 AND ("unitOfMeasure" NOT IN ('UNIT','PAIR') OR quantity=trunc(quantity)) AND jsonb_typeof("serialNumbers")='array' AND "policyVersion">0);

ALTER TABLE "InventoryReceipt" ADD CONSTRAINT inventoryreceipt_confirmation CHECK (version>0 AND ((status='CONFIRMED' AND "confirmedAt" IS NOT NULL AND "confirmationOperationId" IS NOT NULL AND "requestHash" IS NOT NULL) OR (status<>'CONFIRMED' AND "confirmedAt" IS NULL AND "confirmationOperationId" IS NULL AND "requestHash" IS NULL)));

ALTER TABLE "InventoryCountSession" ADD CONSTRAINT inventorycountsession_confirmation CHECK (version>0 AND ((status='CONFIRMED' AND "confirmedAt" IS NOT NULL AND "confirmationOperationId" IS NOT NULL AND "requestHash" IS NOT NULL) OR (status<>'CONFIRMED' AND "confirmedAt" IS NULL AND "confirmationOperationId" IS NULL AND "requestHash" IS NULL)));
