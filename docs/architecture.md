# Architecture & Stack

## Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Framework | SvelteKit + TypeScript | Full-stack, SSR where useful, client-side crypto where needed |
| Styling | Tailwind CSS + DaisyUI | Utility-first with pre-built accessible components |
| i18n | Paraglide | Type-safe, compiler-based, officially supported in sv CLI |
| Database | SQLite via Prisma v7 + `@prisma/adapter-libsql` | Type-safe queries, compile-time safety, single file SQLite |
| Crypto | Web Crypto API (built-in) | Browser standard, zero dependencies |
| QR codes | `qrcode` package | Single responsibility, stable |
| Sessions | Manual (no auth library) | Custom keypair auth doesn't fit conventional auth libraries |
| Logging | Pino | Structured KV-argument logging, JSON to stdout, optional OTEL transport |
| Tracing / metrics | OpenTelemetry SDK (optional) | Enabled via `OTEL_ENABLED=true`, zero overhead when disabled |
| ORM | None — raw SQL | Lean, stable, schema is not complex |

## Key Design Decisions

### All crypto is client-side only
The server never sees plaintext submission data, contact info, or project private keys. All encryption and decryption happens in the browser using the Web Crypto API. SvelteKit pages that perform crypto operations must include `export const ssr = false`.

### No auth library
Authentication is a challenge-response signature flow using the user's keypair. After a successful challenge, a standard `httpOnly` + `Secure` session cookie is issued. Session management is a single sessions table + a `handle` hook in `hooks.server.ts`.

### Prisma over raw SQL
Prisma v7 provides compile-time type safety for all database queries. The schema is the single source of truth. Migrations are managed via `prisma migrate`. The client uses `@prisma/adapter-libsql` as required by Prisma v7's adapter-based connection model. The singleton client lives at `src/lib/server/db/index.ts` and is imported as `$lib/server/db`.

### Project keypair genesis
The infrastructure admin creates a project record (id, name) and a one-time MODERATOR invite link. The first MODERATOR to claim that link generates the project keypair entirely client-side. They upload the project public key and store the project private key encrypted with their own public key. The server never sees the project private key in plaintext.

### MODERATOR promotion
When promoting a submitter to MODERATOR, an already-authorised MODERATOR (online) must decrypt the project private key with their own key and re-encrypt it with the new MODERATOR's public key. This is a synchronous operation — the promoting MODERATOR must be present.

### Local cache
- **Cold storage**: IndexedDB with AES-GCM encrypted blobs. Encryption key derived from user private key via HKDF.
- **Runtime**: On login, cold storage is decrypted and loaded into Svelte stores (in-memory).
- **Search**: Operates on in-memory data. At this scale (≤200 submissions), no need for IndexedDB-level querying.
- **Sync**: New data from server is decrypted, appended to Svelte stores and written back to cold storage.
- **Logout**: In-memory stores are cleared. Cold storage remains encrypted on disk.

## Request Flow

```
Browser                          SvelteKit Server
  |                                    |
  |-- GET /challenge ----------------> |
  |<- { nonce } --------------------- |
  |                                    |
  | [sign nonce with private key]      |
  |                                    |
  |-- POST /auth { pubkey, sig } ----> |
  |   [server verifies sig]            |
  |   [server creates session row]     |
  |<- Set-Cookie: session=... ------- |
  |                                    |
  |-- GET /submissions (+ cookie) --> |
  |<- [encrypted blobs] ------------ |
  |                                    |
  | [decrypt in browser]               |
```

## SvelteKit Route Structure (planned)

```
src/
  routes/
    +layout.svelte              # Global layout, session context
    +layout.server.ts           # Validate session cookie, populate locals.user
    +page.svelte                # Landing / login page

    auth/
      +page.svelte              # Key generation / onboarding (ssr: false)
      challenge/
        +server.ts              # Issue nonce
      verify/
        +server.ts              # Verify signature, create session

    admin/
      +page.svelte              # Infrastructure admin console (env password)
      +page.server.ts

    projects/
      [id]/
        +page.svelte            # Project dashboard (ssr: false)
        +page.server.ts
        submit/
          +page.svelte          # Submission form (ssr: false)
        MODERATOR/
          +page.svelte          # MODERATOR view (ssr: false)

    api/
      projects/
        +server.ts
      submissions/
        +server.ts
      invites/
        +server.ts
      users/
        +server.ts

  lib/
    crypto/                     # Web Crypto API helpers (client-only)
    db/                         # better-sqlite3 queries
    session/                    # Session creation / validation
    stores/                     # Svelte stores (in-memory decrypted cache)
    components/                 # Shared UI components
```
