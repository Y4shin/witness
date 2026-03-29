-- Encrypt submission metadata: preserve legacy plaintext columns as nullable,
-- add schemaVersion to both tables, and add encryptedMeta to SubmissionFile.
--
-- Existing rows keep their plaintext data (schemaVersion=1).
-- The client detects v1 rows, re-encrypts the metadata client-side (where the
-- decryption keys live), and PATCHes the migration endpoints to promote them to
-- schemaVersion=2, at which point the plaintext columns are cleared server-side.
--
-- New rows created after this migration are written as schemaVersion=2 directly
-- by the server handlers.
--
-- PRAGMA foreign_keys = OFF is required for the Submission table-copy step so
-- that the temporary absence of the old table during the rename sequence does not
-- trigger ON DELETE CASCADE on SubmissionFile.

PRAGMA foreign_keys = OFF;

-- ── Submission ────────────────────────────────────────────────────────────────
-- SQLite cannot ALTER COLUMN to change NOT NULL to nullable, so a table copy is
-- needed to make `type` nullable.  All other columns are preserved unchanged.

CREATE TABLE "new_Submission" (
    "id"                  TEXT NOT NULL PRIMARY KEY,
    "projectId"           TEXT NOT NULL,
    "memberId"            TEXT NOT NULL,
    "type"                TEXT,           -- nullable (was NOT NULL enum)
    "archiveCandidateUrl" TEXT,
    "archiveUrl"          TEXT,
    "schemaVersion"       INTEGER NOT NULL DEFAULT 1,
    "encryptedPayload"    TEXT NOT NULL,
    "encryptedKeyProject" TEXT NOT NULL,
    "encryptedKeyUser"    TEXT NOT NULL,
    "submitterSignature"  TEXT NOT NULL,
    "createdAt"           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "new_Submission_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "new_Submission_memberId_fkey"  FOREIGN KEY ("memberId")  REFERENCES "Member"  ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_Submission" (
    "id", "projectId", "memberId",
    "type", "archiveCandidateUrl", "archiveUrl",
    "schemaVersion",
    "encryptedPayload", "encryptedKeyProject", "encryptedKeyUser",
    "submitterSignature", "createdAt"
)
SELECT
    "id", "projectId", "memberId",
    "type", "archiveCandidateUrl", "archiveUrl",
    1,
    "encryptedPayload", "encryptedKeyProject", "encryptedKeyUser",
    "submitterSignature", "createdAt"
FROM "Submission";

DROP TABLE "Submission";
ALTER TABLE "new_Submission" RENAME TO "Submission";

-- ── SubmissionFile ────────────────────────────────────────────────────────────
-- mimeType already exists as a nullable TEXT column — no change needed.
-- Only add the two new columns via ALTER TABLE (no table copy required).

ALTER TABLE "SubmissionFile" ADD COLUMN "encryptedMeta" TEXT;
ALTER TABLE "SubmissionFile" ADD COLUMN "schemaVersion" INTEGER NOT NULL DEFAULT 1;

PRAGMA foreign_keys = ON;
