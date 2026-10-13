-- Public edition: accounts (shared database), résumé drafts and uploads (each tenant).
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "tenant" TEXT NOT NULL,
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lockCount" INTEGER NOT NULL DEFAULT 0,
    "lastLoginAt" TIMESTAMP(3),
    "lastWorkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Account_email_key" ON "Account"("email");
CREATE UNIQUE INDEX "Account_tenant_key" ON "Account"("tenant");

CREATE TABLE "ResumeDraft" (
    "id" TEXT NOT NULL DEFAULT 'me',
    "json" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "origin" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResumeDraft_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResumeUpload" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '[]',
    "method" TEXT NOT NULL DEFAULT 'rules',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResumeUpload_pkey" PRIMARY KEY ("id")
);
