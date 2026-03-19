-- Add submission type and archive fields
ALTER TABLE "Submission" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'WEBPAGE';
ALTER TABLE "Submission" ADD COLUMN "archiveCandidateUrl" TEXT;
ALTER TABLE "Submission" ADD COLUMN "archiveUrl" TEXT;

-- Add mimeType to SubmissionFile
ALTER TABLE "SubmissionFile" ADD COLUMN "mimeType" TEXT;
