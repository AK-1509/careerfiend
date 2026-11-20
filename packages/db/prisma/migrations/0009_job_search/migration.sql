-- Job search: saved searches and their leads (each account); shared source cache and pacing (accounts schema).
CREATE TABLE "SavedSearch" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "titles" TEXT NOT NULL,
    "location" TEXT NOT NULL DEFAULT '',
    "remoteOnly" BOOLEAN NOT NULL DEFAULT false,
    "exclude" TEXT NOT NULL DEFAULT '[]',
    "sources" TEXT NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT '{}',
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SavedSearch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "searchId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "location" TEXT NOT NULL DEFAULT '',
    "remote" BOOLEAN NOT NULL DEFAULT false,
    "url" TEXT NOT NULL,
    "applyUrl" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "descriptionComplete" BOOLEAN NOT NULL DEFAULT false,
    "postedAt" TIMESTAMP(3),
    "compensation" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "jobId" TEXT,
    "foundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Lead_source_externalId_key" ON "Lead"("source", "externalId");
CREATE INDEX "Lead_searchId_status_idx" ON "Lead"("searchId", "status");
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_searchId_fkey" FOREIGN KEY ("searchId") REFERENCES "SavedSearch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SourceCache" (
    "key" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SourceCache_pkey" PRIMARY KEY ("key")
);
CREATE INDEX "SourceCache_expiresAt_idx" ON "SourceCache"("expiresAt");

CREATE TABLE "SourceThrottle" (
    "host" TEXT NOT NULL,
    "nextAt" TIMESTAMP(3) NOT NULL,
    "blockedUntil" TIMESTAMP(3),
    "failures" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SourceThrottle_pkey" PRIMARY KEY ("host")
);
