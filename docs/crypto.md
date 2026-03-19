# Cryptographic Design

All cryptographic operations use the browser's built-in **Web Crypto API**. No third-party crypto library is used.

## Algorithms

| Purpose | Algorithm |
|---|---|
| Asymmetric encryption | RSA-OAEP (4096-bit) or ECDH (P-256) + AES-GCM |
| Symmetric encryption | AES-GCM (256-bit), random 96-bit IV per operation |
| Key derivation (passphrase) | PBKDF2 — SHA-256, 600,000 iterations |
| Key derivation (from key material) | HKDF — SHA-256 |
| Signing / verification | ECDSA (P-256) or Ed25519 (if available) |

> Algorithm choice (RSA-OAEP vs ECDH) to be finalised during implementation. ECDH + AES-GCM (hybrid) is preferred for key size and performance.

## Keys & Their Storage

### User keypair
- Generated client-side on first visit.
- **Private key**: stored in `localStorage`, never leaves the device unless explicitly exported.
- **Public key**: uploaded to server during registration, stored in plaintext in the `users` table.

### Project keypair
- Generated client-side by the **first MODERATOR** when claiming the initial invite link.
- **Public key**: uploaded to server, stored in plaintext in the `projects` table.
- **Private key**: never stored in plaintext on the server. Stored only as `encryptedProjectPrivateKey` in the `memberships` table, encrypted with each MODERATOR's public key.

### IndexedDB cold storage key
- Derived from user private key using HKDF.
- Used to encrypt the local IndexedDB cache at rest.
- Never stored — re-derived from the private key on each login.

## Encryption Flows

### Submitting evidence

```
1. Client generates a random 256-bit symmetric key (K_sym).
2. Client encrypts the form payload with K_sym (AES-GCM).
3. Client encrypts K_sym with the project public key  → encryptedKeyForProject
4. Client encrypts K_sym with the submitter's public key → encryptedKeyForUser
5. Client requests a challenge nonce from the server.
6. Client signs (nonce + SHA-256(encryptedPayload)) with their private key.
7. Client sends: encryptedPayload, encryptedKeyForProject, encryptedKeyForUser, signature.
8. Server verifies signature. Stores all fields. Never sees K_sym or plaintext.
```

### Reading a submission (submitter)

```
1. Fetch encrypted submission from server.
2. Decrypt encryptedKeyForUser with own private key → K_sym.
3. Decrypt encryptedPayload with K_sym → plaintext.
```

### Reading a submission (MODERATOR)

```
1. Fetch encryptedProjectPrivateKey from memberships table.
2. Decrypt it with own private key → project private key.
3. Decrypt encryptedKeyForProject with project private key → K_sym.
4. Decrypt encryptedPayload with K_sym → plaintext.
```

### Registering (first visit)

```
1. Generate user keypair client-side.
2. User enters name and contact info.
3. Encrypt (name + contact) with project public key → encryptedContact.
4. POST public key + encryptedContact to server.
5. Server stores public key in plaintext; contact info stays encrypted.
```

### MODERATOR promotion

```
1. Promoting MODERATOR fetches their encryptedProjectPrivateKey.
2. Decrypts it with own private key → project private key (in memory only).
3. Fetches new MODERATOR's public key from server.
4. Encrypts project private key with new MODERATOR's public key.
5. POSTs the new encryptedProjectPrivateKey for the new MODERATOR.
6. Server updates membership row. In-memory project private key is discarded.
```

### Cross-device linking / export

```
1. User chooses a passphrase.
2. Derive encryption key: PBKDF2(passphrase, random salt, 600k iterations) → K_wrap.
3. Encrypt private key with K_wrap (AES-GCM) → encryptedBundle.
4. Encode: base64(salt + IV + encryptedBundle).
5. For link/QR: embed in URL #fragment (never sent to server).
6. For export: write to downloadable .json file.

Import:
1. Decode base64 → extract salt, IV, encryptedBundle.
2. Re-derive K_wrap from passphrase + salt.
3. Decrypt → private key restored to localStorage.
4. Re-fetch MODERATOR memberships from server.
```

## Submission Authenticity

Each submission includes a **signature** over `nonce || SHA-256(encryptedPayload)` using the submitter's private key. The server verifies this against the stored public key before accepting the submission. This proves:
- The submission came from the registered keypair (authenticity).
- The ciphertext was not tampered with in transit (integrity).
- The submission cannot be replayed (nonce is single-use).

## What the Server Stores (and Sees)

| Data | Stored as | Server can read? |
|---|---|---|
| Submission content | AES-GCM ciphertext | No |
| Symmetric key (project copy) | RSA/ECDH ciphertext | No |
| Symmetric key (user copy) | RSA/ECDH ciphertext | No |
| Project private key | RSA/ECDH ciphertext (per MODERATOR) | No |
| User contact info | RSA/ECDH ciphertext | No |
| User public key | Plaintext | Yes (it's public) |
| Project public key | Plaintext | Yes (it's public) |
| Form schema | Plaintext | Yes |
| Submission signature | Plaintext | Yes (used for verification) |
| Session token | Random opaque token | Yes (used for auth) |
