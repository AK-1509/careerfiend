-- CreateTable
CREATE TABLE "ExperienceProfileCache" (
    "id" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExperienceProfileCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExperienceProfileCache_checksum_version_key" ON "ExperienceProfileCache"("checksum", "version");

