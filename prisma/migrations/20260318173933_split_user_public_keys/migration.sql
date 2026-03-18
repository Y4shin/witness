/*
  Warnings:

  - You are about to drop the column `publicKey` on the `User` table. All the data in the column will be lost.
  - Added the required column `encryptionPublicKey` to the `User` table without a default value. This is not possible if the table is not empty.
  - Added the required column `signingPublicKey` to the `User` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "signingPublicKey" TEXT NOT NULL,
    "encryptionPublicKey" TEXT NOT NULL,
    "encryptedName" TEXT NOT NULL,
    "encryptedContact" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_User" ("createdAt", "encryptedContact", "encryptedName", "id") SELECT "createdAt", "encryptedContact", "encryptedName", "id" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_signingPublicKey_key" ON "User"("signingPublicKey");
CREATE UNIQUE INDEX "User_encryptionPublicKey_key" ON "User"("encryptionPublicKey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
