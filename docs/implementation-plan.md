# Implementation Plan

Steps are ordered by dependency. Each step should be fully working and tested before moving to the next.

---

## Testing Conventions

### Vitest — unit & component tests
- **Unit tests** (`src/lib/**/*.test.ts`): pure logic, no DOM. Run in Node — Web Crypto API available natively in Node 18+.
- **Component tests** (`src/lib/**/*.svelte.test.ts` / `src/routes/**/*.svelte.test.ts`): Svelte components rendered in a real browser via `vitest-browser-svelte` + Playwright. Web Crypto API available natively.
- Run with `npm run test:unit`.

### Playwright — end-to-end tests
- Tests live in `tests/` and cover complete user flows across multiple pages.
- Use a dedicated test database: set `DATABASE_URL=file:./test.db` in the Playwright config env.
- Reset the database before each test file using a `beforeEach` or global setup that runs `prisma migrate reset --force`.
- Each test file is fully self-contained — no shared state between files.
- Run with `npm run test:e2e`.

### Happy path vs. non-happy path
Every feature has both. Happy paths confirm the system works; non-happy paths confirm it fails correctly and safely. Non-happy paths are not optional — a missing 403 or a missing error message is a bug. Each step lists both explicitly.

### General rules
- Crypto roundtrip tests (encrypt → decrypt, sign → verify) must pass before any feature that depends on them is built.
- Never assert on encrypted blobs directly — assert that decrypted output matches the original plaintext.
- Non-happy path API tests must assert both the status code and the response body (error message).
- Playwright tests must assert visible UI feedback for error states, not just the absence of success.

---

## Phase 1 — Foundation

### Step 1: Database setup ✅
- Prisma v7 installed with `@prisma/adapter-libsql` + `@libsql/client`
- Schema defined in `prisma/schema.prisma`
- Initial migration applied (`prisma/migrations/`)
- Prisma client generated to `src/lib/server/prisma/` (gitignored)
- Singleton client at `src/lib/server/db/index.ts`, imported as `$lib/server/db`
- Run `npx prisma migrate dev` for schema changes, `npx prisma generate` after

**Tests:**
- Vitest: DB client connects; basic CRUD on `Project` and `User` succeeds; foreign key violations throw

---

### Step 2: Observability — logging + OpenTelemetry

**Packages:**
- `pino` — structured logger, KV-argument style: `logger.info({ userId, projectId }, 'message')`
- `pino-pretty` (devDependency) — human-readable output during development
- `pino-opentelemetry-transport` — forwards Pino logs into the OpenTelemetry log signal
- `@opentelemetry/sdk-node` — Node.js OpenTelemetry SDK
- `@opentelemetry/auto-instrumentations-node` — auto-instruments HTTP, fetch, etc.
- `@opentelemetry/exporter-otlp-http` — OTLP/HTTP exporter for traces, metrics, logs

**Environment variables:**

| Variable | Default | Purpose |
|---|---|---|
| `OTEL_ENABLED` | `false` | Master switch — set to `true` to enable all telemetry |
| `OTEL_SERVICE_NAME` | `reporting-tool` | Service name in traces/logs |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | _(none)_ | OTLP collector endpoint (e.g. `http://otel-collector:4318`) |
| `LOG_LEVEL` | `info` | Pino log level (`trace`, `debug`, `info`, `warn`, `error`) |
| `LOG_PRETTY` | `false` | Enable `pino-pretty` formatting (development only) |

**Implementation:**
- Create `src/instrumentation.ts` — initialises the OpenTelemetry SDK. Must be loaded before any other server code.
  - When `OTEL_ENABLED=false`: no-op, zero overhead.
  - When `OTEL_ENABLED=true`: registers OTLP exporters for traces, metrics, and logs.
- Create `src/lib/server/logger.ts` — exports a `logger` singleton (Pino instance).
  - When `OTEL_ENABLED=false`: logs JSON to stdout (or pretty-prints if `LOG_PRETTY=true`).
  - When `OTEL_ENABLED=true`: adds `pino-opentelemetry-transport` as a Pino transport alongside stdout.
- Load `src/instrumentation.ts` before SvelteKit starts via the Node `--import` flag in the start script (adapter-node produces a `build/index.js` — wrap it in a `server.js` that does `--import ./instrumentation.js`).
- Use `logger` throughout all server-side code (API routes, hooks, session logic).

**Usage pattern:**
```ts
// Good — structured, searchable, correlatable
logger.info({ userId: user.id, projectId, role }, 'User joined project')
logger.warn({ token, reason: 'expired' }, 'Invite link rejected')
logger.error({ err, userId }, 'Challenge verification failed')

// Bad — unstructured, unsearchable
logger.info(`User ${userId} joined project ${projectId}`)
```

**Tests:**
- Vitest: logger emits a parseable JSON object with the expected keys when called; error logs include the `err` field; `LOG_LEVEL=warn` suppresses `info` logs
- Vitest: `OTEL_ENABLED=false` path does not attempt to connect to a collector (no network calls)

---

### Step 3: Session management
- Create `src/lib/server/session/` — generate token, create session, validate session, delete session
- Update `src/hooks.server.ts` — validate session cookie on every request, populate `locals.user`
- Update `src/app.d.ts` — type `locals.user`
- Log session creation and expiry events via `logger`

**Tests (happy path):**
- Vitest: creating a session returns a token; valid token resolves to the correct user; `locals.user` is populated for authenticated requests

**Tests (non-happy path):**
- Vitest: expired token returns `null` (not a stale user); tampered token returns `null`; deleted token returns `null`; missing cookie results in `locals.user` being `null`; session from a deleted user returns `null`

---

### Step 4: Crypto utilities (client-side only)
- Create `src/lib/crypto/` with helpers for:
  - Keypair generation (ECDH P-256 for encryption, ECDSA P-256 for signing)
  - Hybrid encrypt / decrypt (ECDH key agreement + AES-GCM)
  - Symmetric key generation, encrypt / decrypt (AES-GCM, random 96-bit IV per operation)
  - Sign / verify (ECDSA P-256)
  - PBKDF2 key derivation (passphrase → wrapping key, 600k iterations, random salt)
  - HKDF key derivation (key material → IndexedDB encryption key)
  - Base64url encode/decode for all serialised keys and ciphertext

**Tests — happy path:**
- Keypair generation produces exportable public + private keys
- Encrypt → decrypt roundtrip with same keypair recovers original plaintext
- Symmetric encrypt → decrypt roundtrip recovers plaintext
- Sign → verify returns `true` for correct key + message
- PBKDF2: same passphrase + salt produces the same key deterministically
- HKDF: same input key material produces the same derived key deterministically
- Base64url encode → decode roundtrip is lossless for arbitrary byte arrays

**Tests — non-happy path:**
- Decrypt with wrong private key throws / returns null (does not return garbled data silently)
- Decrypt with wrong symmetric key throws
- Verify returns `false` for a tampered message
- Verify returns `false` for a signature from a different keypair
- PBKDF2 with different salt produces a different key (salts are not ignored)
- Decoding a truncated base64url string throws gracefully

---

## Phase 2 — Auth & Onboarding

### Step 5: Challenge-response auth endpoints
- `GET /api/auth/challenge` — generate nonce, store with short TTL, return it
- `POST /api/auth/verify` — verify signature, consume nonce, create session, set `httpOnly` cookie
- `POST /api/auth/logout` — delete session, clear cookie
- Log auth events (challenge issued, verify success/fail, logout) via `logger`

**Tests — happy path:**
- Vitest: challenge endpoint returns a nonce and stores it; verify with valid signature creates a session and sets a cookie; logout deletes the session and clears the cookie
- Playwright: completing the full challenge-response flow results in an authenticated session cookie

**Tests — non-happy path:**
- Vitest: verify with invalid signature returns 401; verify with an already-used nonce returns 401 (replay blocked); verify with an expired nonce returns 401; verify with unknown public key returns 401; verify with malformed body returns 400
- Playwright: a second attempt to use the same nonce shows an error message; accessing a protected page without a session redirects to login

---

### Step 6: User registration / onboarding flow
- `src/routes/auth/+page.svelte` (`ssr: false`)
- On first visit: generate keypair client-side, prompt for name + contact
- Encrypt name + contact with project public key, POST with public key to `POST /api/users`
- Store private key in localStorage, redirect to challenge → session → dashboard

**Tests — happy path:**
- Vitest (component): form renders; submit button is disabled until name + contact are filled
- Playwright: completing registration stores a key in localStorage and redirects to the dashboard

**Tests — non-happy path:**
- Playwright: submitting with an empty name shows a validation error; submitting with an empty contact shows a validation error; if `POST /api/users` fails (network error), an error message is shown and the private key is not stored; clearing localStorage and revisiting `/auth` presents the registration form again (key is not magically recovered)

---

### Step 7: Infrastructure admin console
- Protect `/admin` with env-level password (server-side only, independent of user sessions)
- Create / delete projects
- Display one-time MODERATOR invite link + QR code after project creation
- Log admin actions via `logger`

**Tests — happy path:**
- Playwright: correct password grants access; creating a project shows an invite link and QR code; deleting a project removes it from the list

**Tests — non-happy path:**
- Playwright: accessing `/admin` without authenticating redirects to the admin login; wrong password shows an error; creating a project with an empty name shows a validation error; attempting to delete a non-existent project returns 404; the admin invite link is single-use — claiming it a second time returns a 410 error page

---

## Phase 3 — Projects & Invites

### Step 8: Invite link system
- `POST /api/invites` — create invite link signed by MODERATOR (or unsigned for admin)
- `GET /api/invites/[token]` — validate token, return project info
- Increment `used_count` on claim; reject if over limit or expired
- Log invite creation, claims, and rejections via `logger`

**Tests — happy path:**
- Vitest: valid token returns project info and role; `used_count` increments on each claim
- Playwright: following a valid invite link presents the onboarding flow

**Tests — non-happy path:**
- Vitest: expired token returns 410; token at `max_uses` returns 410; revoked (deleted) token returns 410; token for a deleted project returns 410; malformed token returns 404; `used_count` does not increment on a rejected claim
- Playwright: visiting an expired invite link shows a clear "link expired" message; visiting a used-up link shows "link no longer valid"

---

### Step 9: Project keypair genesis (first MODERATOR claim)
- First MODERATOR claiming link: generate project keypair client-side, POST public key, store encrypted private key in `memberships`
- Subsequent users claiming a link: skip keypair generation, just register

**Tests — happy path:**
- Playwright: first MODERATOR claim stores a project public key on the server; MODERATOR can decrypt their `encryptedProjectPrivateKey` using their own private key

**Tests — non-happy path:**
- Playwright: second user claiming a link cannot overwrite the project public key (`PATCH` endpoint rejects if key already set — 409); a submitter-role invite link does not trigger keypair genesis even if the project has no public key yet (error shown, operation aborted)

---

### Step 10: QR code generation
- Install `qrcode`
- `QrCode` Svelte component accepting a `value: string` prop

**Tests — happy path:**
- Vitest (component): renders an `<svg>` or `<canvas>` element when given a non-empty value

**Tests — non-happy path:**
- Vitest (component): renders a placeholder / nothing when `value` is empty or undefined; very long values (e.g. a 2000-char URL) render without crashing

---

## Phase 4 — Submissions

### Step 11: Form builder (MODERATOR)
- UI to add/remove/reorder TEXT, SELECT, FILE fields
- `POST /api/projects/[id]/fields`, `GET /api/projects/[id]/fields`

**Tests — happy path:**
- Vitest (component): adding a TEXT field appears in the list; SELECT field shows options input; reordering updates `sortOrder`
- Playwright: MODERATOR creates a two-field form; fields are persisted and returned by the API

**Tests — non-happy path:**
- Vitest (component): submitting a SELECT field with no options shows a validation error
- Playwright: submitter role cannot POST to the fields endpoint (403); unauthenticated request returns 401; creating a field with an empty label returns 400; deleting the only required field and saving is allowed (no artificial minimum)

---

### Step 12: Submission flow (submitter)
- `src/routes/projects/[id]/submit/+page.svelte` (`ssr: false`)
- Encrypt payload + symmetric key for project pubkey and own pubkey
- Sign `nonce || SHA-256(encryptedPayload)`, POST to `POST /api/submissions`
- File fields: encrypt client-side, upload to `POST /api/submissions/[id]/files`
- Log submission receipt (without content) via `logger`

**Tests — happy path:**
- Vitest (component): form renders correct field types; required fields block submission when empty
- Playwright: submitter submits form; `encryptedPayload` in DB is not plaintext; decrypting `encryptedPayload` with submitter's private key recovers original data; decrypting with project private key also recovers data

**Tests — non-happy path:**
- Vitest: submission with tampered signature returns 400; submission with already-used nonce returns 401; submission with unknown public key returns 401
- Playwright: submitting with a missing required field shows a validation error and does not POST; if the server returns an error, the form shows an error message and does not clear the user's input; unauthenticated submission attempt redirects to login

---

### Step 13: Submission views
- Submitter: fetch own submissions, decrypt with own key
- MODERATOR: fetch all submissions, decrypt via project private key, display contact info

**Tests — happy path:**
- Playwright: submitter sees their own submission decrypted; MODERATOR sees all submissions; MODERATOR can decrypt contact info; decrypted values match what was submitted

**Tests — non-happy path:**
- Playwright: submitter requesting another user's submission returns 403; unauthenticated request to submissions API returns 401; submitter cannot access the MODERATOR view route (redirected or shown 403); if decryption fails (e.g. corrupted key in storage), the UI shows a clear decryption error rather than crashing or showing empty fields silently

---

## Phase 5 — MODERATOR Features

### Step 14: MODERATOR promotion
- MODERATOR promotes submitter; client decrypts project private key, re-encrypts for new MODERATOR, POSTs
- Log promotion events via `logger`

**Tests — happy path:**
- Playwright: promoted user can decrypt `encryptedProjectPrivateKey` with own private key; promoted user can view all submissions

**Tests — non-happy path:**
- Playwright: submitter attempting to promote another user returns 403; MODERATOR attempting to demote another MODERATOR is blocked (no demotion endpoint — 404/405); promoting a user who is already an MODERATOR returns 409; promoting a user from a different project returns 404

---

### Step 15: Invite link management UI
- MODERATORs generate submitter/MODERATOR invite links with expiry / max-uses
- List and revoke active links; display as link + QR code

**Tests — happy path:**
- Vitest (component): invite form renders role selector and optional expiry/max-uses fields
- Playwright: MODERATOR creates an MODERATOR invite link; new user claims it and is promoted to MODERATOR

**Tests — non-happy path:**
- Playwright: submitter attempting to create an invite link returns 403; revoking a link makes subsequent claims return 410; setting `max_uses=1` and claiming twice — second claim is rejected; creating a link with an expiry in the past returns 400; a non-MODERATOR cannot see the invite management UI (route guard)

---

## Phase 6 — Local Cache

### Step 16: IndexedDB cold storage
- `src/lib/stores/cache.ts` — derive IndexedDB key via HKDF, encrypt at rest
- On login: decrypt cold storage → load into Svelte stores
- On new data: update stores + write encrypted to cold storage
- On logout: clear in-memory stores (cold storage persists encrypted)

**Tests — happy path:**
- Vitest: write encrypted record → re-derive key → decrypt recovers original; re-login with same key recovers cached record
- Playwright: after loading submissions, intercept all API routes via `page.route('**', r => r.abort())`; reload — cached data is still visible

**Tests — non-happy path:**
- Vitest: attempting to read cold storage with a wrong derived key (simulated key mismatch) throws; logout clears in-memory store but leaves IndexedDB record intact
- Playwright: importing a different user's key and attempting to decrypt cold storage from the original user shows a decryption error (not a crash)

---

### Step 17: In-memory search
- Filter submissions via Svelte store derived values; plain `Array.filter` + string matching

**Tests — happy path:**
- Vitest: searching for a known string returns matching submissions; empty query returns all

**Tests — non-happy path:**
- Vitest: searching for a string not present in any submission returns an empty array (not an error); search is case-insensitive; search with special regex characters does not throw (input is treated as a literal string, not a regex)

---

## Phase 7 — Key Management

### Step 18: Cross-device linking
- Generate link/QR: PBKDF2(passphrase) → AES-GCM encrypt key bundle → base64url in `#fragment`
- Receiving page: decode fragment → prompt passphrase → decrypt → store key → onboard

**Tests — happy path:**
- Vitest: encrypt bundle → decrypt with same passphrase recovers private key
- Playwright: device B opens link from device A, enters correct passphrase, gets the same private key as device A

**Tests — non-happy path:**
- Vitest: decrypt with wrong passphrase throws (does not return null silently); decoding a truncated or malformed fragment throws a user-readable error, not an unhandled exception
- Playwright: entering the wrong passphrase shows an error and prompts again; opening a link with a corrupted fragment (manually edited URL) shows a "link is invalid" message; opening the link without the `#fragment` (e.g. server-side redirect strips it) shows a "link is incomplete" message

---

### Step 19: Export / import
- Export: PBKDF2(passphrase) → encrypt private key → download `.json`
- Import: read file → prompt passphrase → decrypt → restore key → re-sync from server

**Tests — happy path:**
- Vitest: exported JSON contains `salt`, `iv`, `ciphertext` fields; importing with correct passphrase restores the private key
- Playwright: export from device A, import on device B (fresh browser context), authenticate — session established with imported key

**Tests — non-happy path:**
- Vitest: importing a file with missing fields throws a clear validation error; importing with wrong passphrase throws (does not silently store a corrupt key)
- Playwright: importing a corrupted JSON file shows a parse error; entering the wrong passphrase during import shows an error and does not store anything in localStorage; after a failed import, the existing key in localStorage (if any) is unchanged

---

## Phase 8 — Polish

### Step 20: i18n (Paraglide)
- All UI strings in `messages/en.json` and `messages/de.json`
- Language switcher component
- All user-facing text (including all error messages) goes through Paraglide

**Tests — happy path:**
- Playwright: switching to German updates visible text on the registration and submission pages

**Tests — non-happy path:**
- Vitest: a lint-style test that greps `.svelte` files for hardcoded non-trivial English strings not wrapped in a Paraglide message call
- Playwright: switching language mid-flow (e.g. during form fill) does not clear the form or lose state

---

### Step 21: Adapter & deployment config
- Swap `adapter-auto` for `adapter-node` in `svelte.config.js`
- Create `server.js` wrapper that loads `src/instrumentation.ts` via `--import` before starting the SvelteKit Node server (required for OpenTelemetry to instrument early enough)
- Environment variables to document in `.env.example`: `ADMIN_PASSWORD`, `DATABASE_URL`, `SESSION_SECRET`, `OTEL_ENABLED`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `LOG_LEVEL`, `LOG_PRETTY`
- Create `docs/deployment.md`

**Tests:**
- Playwright (smoke — runs against production build): admin creates project → MODERATOR claims link → submitter registers and submits → MODERATOR views decrypted submission → all log lines emitted contain `level`, `time`, and `msg` fields (structured log assertion)
- Playwright: start server with `OTEL_ENABLED=false` — no connection attempts to any OTLP endpoint; start with `OTEL_ENABLED=true` and a mock collector — traces and logs arrive at the collector

---

## Deferred / Optional

- File size limits and server-side validation of encrypted blob sizes
- Submission comments / MODERATOR questions (encrypted comment thread per submission)
- Email notifications (contact info is stored; sending is a separate integration)
- Rate limiting on auth and submission endpoints
- Audit log for MODERATOR actions (promotions, link creation, revocations)
