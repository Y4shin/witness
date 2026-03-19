-- Rename OBSERVER role to MODERATOR
UPDATE "Membership" SET "role" = 'MODERATOR' WHERE "role" = 'OBSERVER';
UPDATE "InviteLink" SET "role" = 'MODERATOR' WHERE "role" = 'OBSERVER';