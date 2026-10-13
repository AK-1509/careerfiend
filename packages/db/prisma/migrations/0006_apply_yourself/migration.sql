-- "Failed" becomes "Apply yourself": the documents are ready and you apply on the employer's site.
INSERT INTO "StatusEvent" ("id", "applicationId", "from", "to", "actor", "reason", "createdAt")
SELECT 'se_manual_' || "id", "id", 'FAILED', 'MANUAL', 'system:migration', 'Failed is now Apply yourself: the documents are ready to apply by hand.', CURRENT_TIMESTAMP
FROM "Application" WHERE "state" = 'FAILED';

UPDATE "Application" SET "state" = 'MANUAL' WHERE "state" = 'FAILED';
