-- Public edition: questions read from the application form, and drafts, for copy and paste.
ALTER TABLE "Application" ADD COLUMN "answerSheet" TEXT NOT NULL DEFAULT '{}';
