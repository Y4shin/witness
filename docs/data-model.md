# Data Model

Database: **SQLite** via `better-sqlite3`. Migrations are plain numbered `.sql` files in `migrations/`, applied at server startup.

## Schema

### `projects`
```sql
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,          -- UUID
  name        TEXT NOT NULL,
  public_key  TEXT NOT NULL,             -- Base64-encoded project public key (plaintext)
  created_at  INTEGER NOT NULL           -- Unix timestamp
);
```

### `users`
```sql
CREATE TABLE users (
  id               TEXT PRIMARY KEY,     -- UUID
  public_key       TEXT NOT NULL UNIQUE, -- Base64-encoded user public key (plaintext)
  encrypted_name    TEXT NOT NULL,        -- Encrypted with project public key
  encrypted_contact TEXT NOT NULL,        -- Encrypted with project public key
  created_at       INTEGER NOT NULL
);
```
> Note: a user is scoped to a project at registration. If multi-project membership is needed later, encrypted_name/contact move to `memberships`.

### `memberships`
```sql
CREATE TABLE memberships (
  user_id                      TEXT NOT NULL REFERENCES users(id),
  project_id                   TEXT NOT NULL REFERENCES projects(id),
  role                         TEXT NOT NULL CHECK (role IN ('SUBMITTER', 'MODERATOR')),
  encrypted_project_private_key TEXT,    -- Non-null for MODERATORs only. Encrypted with user's public key.
  joined_at                    INTEGER NOT NULL,
  PRIMARY KEY (user_id, project_id)
);
```

### `sessions`
```sql
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,           -- UUID
  user_id    TEXT NOT NULL REFERENCES users(id),
  token      TEXT NOT NULL UNIQUE,       -- Random opaque token (stored in httpOnly cookie)
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
```

### `challenges`
```sql
CREATE TABLE challenges (
  nonce      TEXT PRIMARY KEY,           -- Random nonce issued to client
  expires_at INTEGER NOT NULL            -- Short TTL (e.g. 5 minutes)
);
```
> Consumed (deleted) on first use. Prevents replay attacks.

### `invite_links`
```sql
CREATE TABLE invite_links (
  id                TEXT PRIMARY KEY,    -- UUID
  token             TEXT NOT NULL UNIQUE,-- Random token embedded in the link
  project_id        TEXT NOT NULL REFERENCES projects(id),
  created_by        TEXT REFERENCES users(id), -- NULL for admin-generated links
  creator_signature TEXT,               -- Signature over (token + project_id + role + expires_at)
  role              TEXT NOT NULL CHECK (role IN ('SUBMITTER', 'MODERATOR')),
  max_uses          INTEGER,             -- NULL = unlimited
  used_count        INTEGER NOT NULL DEFAULT 0,
  expires_at        INTEGER,             -- NULL = no expiry
  created_at        INTEGER NOT NULL
);
```

### `submissions`
```sql
CREATE TABLE submissions (
  id                      TEXT PRIMARY KEY,  -- UUID
  project_id              TEXT NOT NULL REFERENCES projects(id),
  user_id                 TEXT NOT NULL REFERENCES users(id),
  encrypted_payload       TEXT NOT NULL,     -- AES-GCM ciphertext of form data (JSON)
  encrypted_key_project   TEXT NOT NULL,     -- Symmetric key encrypted with project public key
  encrypted_key_user      TEXT NOT NULL,     -- Symmetric key encrypted with submitter public key
  submitter_signature     TEXT NOT NULL,     -- Signature over (nonce + SHA-256(encrypted_payload))
  created_at              INTEGER NOT NULL
);
```

### `submission_files`
```sql
CREATE TABLE submission_files (
  id                   TEXT PRIMARY KEY,     -- UUID
  submission_id        TEXT NOT NULL REFERENCES submissions(id),
  field_name           TEXT NOT NULL,
  storage_path         TEXT NOT NULL,        -- Path to encrypted file on disk
  encrypted_key        TEXT NOT NULL,        -- Symmetric key encrypted with project public key
  encrypted_key_user   TEXT NOT NULL,        -- Symmetric key encrypted with submitter public key
  size_bytes           INTEGER NOT NULL,
  created_at           INTEGER NOT NULL
);
```

### `form_fields`
```sql
CREATE TABLE form_fields (
  id          TEXT PRIMARY KEY,              -- UUID
  project_id  TEXT NOT NULL REFERENCES projects(id),
  label       TEXT NOT NULL,                 -- Stored plaintext (field labels are not sensitive)
  type        TEXT NOT NULL CHECK (type IN ('TEXT', 'SELECT', 'FILE')),
  options     TEXT,                          -- JSON array of strings, for SELECT fields
  required    INTEGER NOT NULL DEFAULT 0,    -- Boolean
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
```

## Notes

- All IDs are UUIDs generated client-side or server-side (both are fine — UUIDs don't leak sequence information).
- All timestamps are Unix timestamps (integers) for simplicity.
- `better-sqlite3` is synchronous — no `async/await` needed in database access code.
- Expired sessions and challenges should be cleaned up periodically (a startup sweep is sufficient at this scale).
