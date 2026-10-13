-- CreateTable
CREATE TABLE "ProjectIdeaRun" (
    "id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "jobs" TEXT NOT NULL,
    "research" TEXT,
    "sources" TEXT NOT NULL DEFAULT '[]',
    "ideas" TEXT NOT NULL DEFAULT '[]',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ProjectIdeaRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectIdeaRun_createdAt_idx" ON "ProjectIdeaRun"("createdAt");

-- CreateIndex
CREATE INDEX "ProjectIdeaRun_status_idx" ON "ProjectIdeaRun"("status");

