# E2E Test Status

## Current state

As of the last full run: **96 passed, 1 failing**.

The 1 remaining failure is:

```
tests/admin.e2e.ts:83:2 › admin console › deleting a project removes it from the list
```

---

## What was done (this session)

### Root cause of cache test failures (now fixed)

The `tests/cache.e2e.ts` tests were failing with "Unknown public key" during auto-login.
The cause: the test generates keys in Node.js (`crypto.subtle.exportKey`) and seeds them into the DB via the seed endpoint. The browser later imports the same keys and re-exports them (via `performLoginForProject` → `importUserKeyBundleJwk` → `exportPublicKeyJwk` → `jwkToString`). Node.js and Chrome may produce different JSON field ordering when stringifying the same JWK, so the exact-string DB lookup fails.

**Fixes applied:**

1. **`src/lib/crypto/keys.ts`** — `jwkToString` now produces canonical JSON (alphabetically sorted keys):
   ```ts
   export function jwkToString(jwk: JsonWebKey): string {
     return JSON.stringify(
       Object.fromEntries(
         Object.entries(jwk as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
       )
     );
   }
   ```

2. **`src/routes/api/_test/seed/+server.ts`** — The `type: 'member'` seed handler now normalizes `signingPublicKey` and `encryptionPublicKey` to canonical form before storing in the DB.

3. **`src/lib/server/auth/index.ts`** — `verifyChallenge` now normalizes the incoming `signingPublicKey` to canonical form before the DB lookup, so keys stored in any field order (from old seeds or non-canonical clients) are still found.

4. **`tests/admin.e2e.ts`** — Added explicit `await expect(row.locator('[data-testid=confirm-delete-project]')).toBeVisible({ timeout: 5000 })` between clicking "Delete" and "Confirm delete", to give Svelte time to re-render the confirm UI before Playwright tries to click it.

---

## Remaining failure: admin delete test

### Symptom

The test passes when run in isolation (`npm run test:e2e -- --grep "deleting a project"`), but fails in the full suite after other tests have seeded 20+ projects into the DB.

The error is a 30-second test timeout on clicking `[data-testid=confirm-delete-project]` — the confirm button never appears after clicking the "Delete" button.

The Playwright page snapshot at timeout shows:
- The "Delete" button is still visible (no confirm button)
- There are 20+ `<li>` project rows

The explicit `toBeVisible` wait (added above) may help, but the root cause is unclear. Theories:
- With many list items Svelte's re-render may be delayed enough that Playwright's default click timeout expires before the confirm button is visible. The explicit wait should address this.
- Alternatively, there may be a click-actionability issue caused by the success section (invite link) overlapping the project list when many projects are present.

### What to try next

1. **Run the full suite and check if the explicit `toBeVisible` wait fixed it.** This is the most likely fix.

2. **If still failing:** add a `test.beforeEach` to the admin describe block that resets the DB projects:
   - Add a `type: 'reset'` or `type: 'clearProjects'` handler to `src/routes/api/_test/seed/+server.ts` that runs `db.project.deleteMany({})`
   - Call it in `test.beforeEach` for the admin tests to ensure a clean slate

3. **If still failing:** scroll the row into view explicitly before clicking delete:
   ```ts
   await row.scrollIntoViewIfNeeded();
   await row.locator('[data-testid=delete-project]').click();
   ```

---

## Files changed in this session

| File | Change |
|------|--------|
| `src/lib/crypto/keys.ts` | `jwkToString` now sorts JWK keys canonically |
| `src/lib/server/auth/index.ts` | Normalizes `signingPublicKey` before DB lookup |
| `src/routes/api/_test/seed/+server.ts` | Normalizes keys before storing member |
| `tests/admin.e2e.ts` | Added explicit wait for confirm button before clicking |

All other e2e fixes were done in the prior session (see conversation transcript).
