-- AlterTable
ALTER TABLE "Job" DROP COLUMN "blockers",
DROP COLUMN "decision",
DROP COLUMN "skipReason";


-- Requirement rows no longer carry gate statuses.
UPDATE "RequirementMatch" SET "status" = 'GAP' WHERE "status" = 'BLOCKER';
UPDATE "RequirementMatch" SET "status" = 'NOT_APPLICABLE' WHERE "status" = 'WARNING';
