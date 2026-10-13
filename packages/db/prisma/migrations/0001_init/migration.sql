-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "UserProfile" (
    "id" TEXT NOT NULL DEFAULT 'me',
    "contact" TEXT NOT NULL,
    "policies" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceDocument" (
    "id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "commit" TEXT NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "extractionStatus" TEXT NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExperienceFact" (
    "id" TEXT NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "experienceId" TEXT,
    "experienceType" TEXT,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'VERIFIED_FROM_SOURCE',
    "ordinal" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExperienceFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfileValue" (
    "key" TEXT NOT NULL,
    "value" TEXT,
    "status" TEXT NOT NULL,
    "sensitive" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileValue_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "normalizedLabel" TEXT NOT NULL,
    "aliases" TEXT NOT NULL DEFAULT '[]',
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "inResumeRegistry" BOOLEAN NOT NULL DEFAULT false,
    "evidence" TEXT NOT NULL DEFAULT '[]',
    "scope" TEXT,
    "claimLimit" TEXT,
    "basis" TEXT,
    "confirmGroup" TEXT,
    "parent" TEXT,
    "firstSeen" TEXT,
    "suggestedEvidence" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillStatusEvent" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "from" TEXT,
    "to" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkillStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "canonicalUrl" TEXT NOT NULL,
    "applyUrl" TEXT,
    "company" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "compensation" TEXT,
    "normalized" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "snapshotPath" TEXT,
    "contentHash" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "skipReason" TEXT,
    "coverage" DOUBLE PRECISION,
    "gaps" TEXT NOT NULL DEFAULT '[]',
    "blockers" TEXT NOT NULL DEFAULT '[]',
    "warnings" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequirementMatch" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "skillIds" TEXT NOT NULL DEFAULT '[]',
    "evidenceKeys" TEXT NOT NULL DEFAULT '[]',
    "confidence" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL,
    "note" TEXT,

    CONSTRAINT "RequirementMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "currentRevisionId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "deferredUntil" TIMESTAMP(3),
    "sourceCommit" TEXT,
    "failureCategory" TEXT,
    "failureMessage" TEXT,
    "failedDuringSubmit" BOOLEAN NOT NULL DEFAULT false,
    "takeoverRequested" BOOLEAN NOT NULL DEFAULT false,
    "tracking" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationRevision" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "warnings" TEXT NOT NULL DEFAULT '[]',
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicationRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeneratedDocument" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "templateVersion" TEXT NOT NULL,
    "provenance" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeneratedDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormField" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "step" INTEGER NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "control" TEXT NOT NULL,
    "semanticType" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL,
    "options" TEXT NOT NULL DEFAULT '[]',
    "proposedValue" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "provenance" TEXT NOT NULL DEFAULT '[]',
    "sensitive" BOOLEAN NOT NULL,
    "reviewState" TEXT NOT NULL,
    "validationMessage" TEXT,
    "note" TEXT,

    CONSTRAINT "FormField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "revisionHash" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmation" TEXT NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "invalidReason" TEXT,
    "audit" TEXT NOT NULL DEFAULT '{}',

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubmissionAttempt" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "revisionHash" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "result" TEXT NOT NULL DEFAULT 'PENDING',
    "confirmationUrl" TEXT,
    "confirmationText" TEXT,
    "screenshotPath" TEXT,
    "errorCategory" TEXT,
    "errorMessage" TEXT,

    CONSTRAINT "SubmissionAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailMessage" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "toAddress" TEXT,
    "subject" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "matchStatus" TEXT NOT NULL,
    "classification" TEXT,
    "confidence" DOUBLE PRECISION,
    "snippet" TEXT NOT NULL DEFAULT '',
    "evidence" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailThreadLink" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "assignedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailThreadLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatusEvent" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "from" TEXT,
    "to" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserQuestion" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "semanticType" TEXT,
    "question" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "options" TEXT NOT NULL DEFAULT '[]',
    "sensitive" BOOLEAN NOT NULL DEFAULT false,
    "answer" TEXT,
    "reusable" BOOLEAN NOT NULL DEFAULT false,
    "answeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkItem" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "dedupeKey" TEXT,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "leaseUntil" TIMESTAMP(3),
    "leasedBy" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchlistCompany" (
    "id" TEXT NOT NULL,
    "ats" TEXT NOT NULL,
    "boardSlug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastPolledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchlistCompany_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "OAuthToken" (
    "provider" TEXT NOT NULL,
    "encrypted" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "account" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OAuthToken_pkey" PRIMARY KEY ("provider")
);

-- CreateTable
CREATE TABLE "StoredFile" (
    "path" TEXT NOT NULL,
    "applicationId" TEXT,
    "contentType" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoredFile_pkey" PRIMARY KEY ("path")
);

-- CreateIndex
CREATE UNIQUE INDEX "SourceDocument_checksum_key" ON "SourceDocument"("checksum");

-- CreateIndex
CREATE INDEX "ExperienceFact_key_idx" ON "ExperienceFact"("key");

-- CreateIndex
CREATE UNIQUE INDEX "ExperienceFact_sourceDocumentId_key_key" ON "ExperienceFact"("sourceDocumentId", "key");

-- CreateIndex
CREATE INDEX "Skill_normalizedLabel_idx" ON "Skill"("normalizedLabel");

-- CreateIndex
CREATE UNIQUE INDEX "Job_canonicalUrl_key" ON "Job"("canonicalUrl");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationRevision_applicationId_number_key" ON "ApplicationRevision"("applicationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionAttempt_approvalId_key" ON "SubmissionAttempt"("approvalId");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionAttempt_idempotencyKey_key" ON "SubmissionAttempt"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "EmailMessage_providerId_key" ON "EmailMessage"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailThreadLink_applicationId_messageId_key" ON "EmailThreadLink"("applicationId", "messageId");

-- CreateIndex
CREATE INDEX "StatusEvent_applicationId_createdAt_idx" ON "StatusEvent"("applicationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserQuestion_applicationId_kind_fieldKey_key" ON "UserQuestion"("applicationId", "kind", "fieldKey");

-- CreateIndex
CREATE UNIQUE INDEX "WorkItem_dedupeKey_key" ON "WorkItem"("dedupeKey");

-- CreateIndex
CREATE INDEX "WorkItem_status_runAt_idx" ON "WorkItem"("status", "runAt");

-- CreateIndex
CREATE UNIQUE INDEX "WatchlistCompany_ats_boardSlug_key" ON "WatchlistCompany"("ats", "boardSlug");

-- CreateIndex
CREATE INDEX "StoredFile_applicationId_idx" ON "StoredFile"("applicationId");

-- AddForeignKey
ALTER TABLE "ExperienceFact" ADD CONSTRAINT "ExperienceFact_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "SourceDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillStatusEvent" ADD CONSTRAINT "SkillStatusEvent_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequirementMatch" ADD CONSTRAINT "RequirementMatch_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationRevision" ADD CONSTRAINT "ApplicationRevision_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeneratedDocument" ADD CONSTRAINT "GeneratedDocument_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormField" ADD CONSTRAINT "FormField_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionAttempt" ADD CONSTRAINT "SubmissionAttempt_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionAttempt" ADD CONSTRAINT "SubmissionAttempt_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "Approval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailThreadLink" ADD CONSTRAINT "EmailThreadLink_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailThreadLink" ADD CONSTRAINT "EmailThreadLink_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "EmailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusEvent" ADD CONSTRAINT "StatusEvent_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserQuestion" ADD CONSTRAINT "UserQuestion_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

