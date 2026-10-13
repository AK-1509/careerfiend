-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "endorsed" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "BankedSkill" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "normalizedLabel" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "sources" TEXT NOT NULL DEFAULT '[]',
    "timesSeen" INTEGER NOT NULL DEFAULT 1,
    "matchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankedSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransferMatch" (
    "id" TEXT NOT NULL,
    "bankedSkillId" TEXT NOT NULL,
    "evidenceType" TEXT NOT NULL,
    "evidenceRef" TEXT NOT NULL,
    "evidenceText" TEXT NOT NULL,
    "url" TEXT,
    "score" DOUBLE PRECISION NOT NULL,
    "method" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransferMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BankedSkill_normalizedLabel_key" ON "BankedSkill"("normalizedLabel");

-- CreateIndex
CREATE INDEX "BankedSkill_status_idx" ON "BankedSkill"("status");

-- CreateIndex
CREATE UNIQUE INDEX "TransferMatch_bankedSkillId_evidenceType_evidenceRef_key" ON "TransferMatch"("bankedSkillId", "evidenceType", "evidenceRef");

-- AddForeignKey
ALTER TABLE "TransferMatch" ADD CONSTRAINT "TransferMatch_bankedSkillId_fkey" FOREIGN KEY ("bankedSkillId") REFERENCES "BankedSkill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

