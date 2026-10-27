-- CreateEnum
CREATE TYPE "FiscalVatCondition" AS ENUM ('RESPONSABLE_INSCRIPTO', 'MONOTRIBUTO', 'EXENTO', 'CONSUMIDOR_FINAL', 'NO_ALCANZADO');

-- CreateEnum
CREATE TYPE "GrossIncomeRegime" AS ENUM ('LOCAL', 'MULTILATERAL_AGREEMENT', 'EXEMPT', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "ArcaEnvironment" AS ENUM ('HOMOLOGATION');

-- CreateEnum
CREATE TYPE "ArcaCredentialStatus" AS ENUM ('CSR_READY', 'CERTIFICATE_INSTALLED', 'ACTIVE', 'REPLACED');

-- CreateTable
CREATE TABLE "OrganizationFiscalProfile" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "legalName" VARCHAR(200),
    "tradeName" VARCHAR(200),
    "cuit" VARCHAR(11),
    "vatCondition" "FiscalVatCondition",
    "grossIncomeRegime" "GrossIncomeRegime",
    "grossIncomeNumber" VARCHAR(40),
    "addressLine" VARCHAR(250),
    "locality" VARCHAR(120),
    "province" VARCHAR(100),
    "postalCode" VARCHAR(20),
    "country" CHAR(2),
    "nationalActivityCode" CHAR(6),
    "multilateralActivityCode" CHAR(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OrganizationFiscalProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArcaIntegrationConfig" (
    "organizationId" UUID NOT NULL,
    "environment" "ArcaEnvironment" NOT NULL DEFAULT 'HOMOLOGATION',
    "service" VARCHAR(32) NOT NULL DEFAULT 'wsfe',
    "version" INTEGER NOT NULL DEFAULT 1,
    "authBlockedUntil" TIMESTAMPTZ(3),
    "lastTicketExpiresAt" TIMESTAMPTZ(3),
    "lastObtainedAt" TIMESTAMPTZ(3),
    "lastResultCode" VARCHAR(40),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ArcaIntegrationConfig_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "ArcaCredential" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "environment" "ArcaEnvironment" NOT NULL DEFAULT 'HOMOLOGATION',
    "commonName" VARCHAR(64) NOT NULL,
    "legalName" VARCHAR(200) NOT NULL,
    "cuit" VARCHAR(11) NOT NULL,
    "status" "ArcaCredentialStatus" NOT NULL DEFAULT 'CSR_READY',
    "version" INTEGER NOT NULL DEFAULT 1,
    "generationOperationId" UUID NOT NULL,
    "generationHash" CHAR(64) NOT NULL,
    "privateKeyStorageKey" VARCHAR(80) NOT NULL,
    "csrStorageKey" VARCHAR(80) NOT NULL,
    "certificateStorageKey" VARCHAR(80),
    "certificateFingerprint" VARCHAR(95),
    "certificateSerial" VARCHAR(128),
    "certificateSubject" VARCHAR(2000),
    "certificateIssuer" VARCHAR(2000),
    "validFrom" TIMESTAMPTZ(3),
    "validTo" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ArcaCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationFiscalProfile_organizationId_key" ON "OrganizationFiscalProfile"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ArcaCredential_privateKeyStorageKey_key" ON "ArcaCredential"("privateKeyStorageKey");

-- CreateIndex
CREATE UNIQUE INDEX "ArcaCredential_csrStorageKey_key" ON "ArcaCredential"("csrStorageKey");

-- CreateIndex
CREATE UNIQUE INDEX "ArcaCredential_certificateStorageKey_key" ON "ArcaCredential"("certificateStorageKey");

-- CreateIndex
CREATE INDEX "ArcaCredential_organizationId_environment_createdAt_id_idx" ON "ArcaCredential"("organizationId", "environment", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ArcaCredential_organizationId_id_key" ON "ArcaCredential"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ArcaCredential_organizationId_generationOperationId_key" ON "ArcaCredential"("organizationId", "generationOperationId");

-- AddForeignKey
ALTER TABLE "OrganizationFiscalProfile" ADD CONSTRAINT "OrganizationFiscalProfile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ArcaIntegrationConfig" ADD CONSTRAINT "ArcaIntegrationConfig_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ArcaCredential" ADD CONSTRAINT "ArcaCredential_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
