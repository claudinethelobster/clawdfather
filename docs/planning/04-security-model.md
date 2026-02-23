# Security Model & Threat Model

> Clawdfather — Mobile-First Account-Based SSH Orchestration

---

## 4.1 Key Management Strategy

### Keypair Generation

- **Algorithm:** Ed25519 (elliptic curve, 256-bit keys, fast, compact signatures)
- **Generation:** Node.js `crypto.generateKeyPair('ed25519')` — uses the OpenSSL CSPRNG seeded from OS entropy (`/dev/urandom`). **Never** user-controlled entropy.
- **Output format:** Private key as PEM (PKCS#8), public key as OpenSSH `ssh-ed25519` format for `authorized_keys` compatibility.
- **Key comment:** `clawdfather:<label>` appended to public key for identification on remote servers.
- **Limit:** Maximum 5 active keypairs per account (prevents abuse, simplifies management).

### Private Key Encryption at Rest

All private keys are encrypted before storage using AES-256-GCM:

```
                                  ┌──────────────┐
                                  │  Master Key  │
                                  │  (env/KMS)   │
                                  └──────┬───────┘
                                         │
                                   HKDF-SHA256
                                  info: "clawdfather-kek"
                                  salt: account_id bytes
                                         │
                                         ▼
                                  ┌──────────────┐
                                  │  Per-Account  │
                                  │     KEK      │
                                  │  (256-bit)   │
                                  └──────┬───────┘
                                         │
                              AES-256-GCM encrypt
                              nonce: 12-byte CSPRNG
                                         │
                                         ▼
                              ┌─────────────────────┐
                              │  private_key_enc     │
                              │  <nonce>:<ct>:<tag>  │
                              └─────────────────────┘
```

**Storage format in `agent_keypairs.private_key_enc`:**
```
<base64(12-byte nonce)>:<base64(ciphertext)>:<base64(16-byte auth tag)>
```

**KEK derivation:**
```typescript
const kek = crypto.hkdfSync(
  'sha256',
  masterKeyBuffer,        // 32-byte master key from env/KMS
  accountIdBuffer,        // account UUID as salt
  'clawdfather-kek',      // info string
  32                      // output 256-bit key
);
```

### Master Key Management

| Environment | Storage | Access |
|-------------|---------|--------|
| **Development** | `CLAWDFATHER_MASTER_KEY` environment variable (32 random bytes, hex-encoded) | Process memory only |
| **Staging** | AWS Secrets Manager or GCP Secret Manager | IAM-gated, versioned |
| **Production** | AWS KMS / GCP KMS (HSM-backed) | Envelope encryption — KMS wraps/unwraps the master key; raw key never leaves KMS boundary in production |

### KEK Rotation Strategy

Master key rotation uses a dual-key approach to avoid re-encrypting all keys simultaneously:

1. **Phase 1:** New master key deployed alongside old master key (both stored as `MASTER_KEY_CURRENT` and `MASTER_KEY_PREVIOUS`)
2. **Phase 2:** On next private key access for each account, system decrypts with old KEK, re-encrypts with new KEK, updates `private_key_enc`
3. **Phase 3:** Background job iterates all accounts, re-encrypts remaining keys. Progress tracked in migration table.
4. **Phase 4:** After all keys re-encrypted, remove `MASTER_KEY_PREVIOUS`

**Timeline:** 7-day rotation window. Alerting if any keys remain on old master key after 72 hours.

### SSH Key Rotation Workflow

Per-account key rotation (user-initiated or policy-triggered):

1. **Generate** new Ed25519 keypair with same label
2. **For each connection using old key:**
   - Establish SSH connection with old key (still active)
   - Run install command to add new public key to `~/.ssh/authorized_keys`
   - Test connection with new key
   - Remove old public key from `~/.ssh/authorized_keys`
3. **Mark old key as rotated** (`is_active = false`, `rotated_at = NOW()`)
4. **7-day grace period:** Old key kept in DB (not deleted) for active session teardown. Sessions using old key continue until natural close.
5. **After grace period:** Mark old key as revoked (`revoked_at = NOW()`)

If step 2 fails for any connection (server unreachable), rotation is paused for that connection with user notification: "Key rotation incomplete — could not update [connection_label]. Retry when server is available."

### Revocation

When a key is revoked (`DELETE /api/v1/keys/:id`):
- `is_active` set to `false`, `revoked_at` set to `NOW()`
- All active session_leases using this keypair are flagged
- Background heartbeat checker (every 60s) detects revoked key usage and terminates affected sessions:
  - Sends `ssh -O exit` to ControlMaster socket
  - Updates session_lease: `status = 'closed'`, `close_reason = 'key_revoked'`
  - WebSocket clients notified: `{ "type": "session_closed", "reason": "key_revoked" }`

---

## 4.2 Host Key Verification Policy

### Trust On First Use (TOFU)

On the first connection test for a new SSH connection:

1. SSH client connects with `StrictHostKeyChecking=ask` equivalent behavior
2. Server's host key fingerprint extracted (SHA-256 of the host's public key)
3. **Fingerprint shown to user** in the app: "This server identifies as SHA256:abc123... Is this your server?"
4. User must **explicitly tap "Trust"** to proceed
5. Fingerprint stored in `ssh_connections.host_key_fingerprint`

**No automatic trust.** No `StrictHostKeyChecking=no`. No silent acceptance.

### Pinning

After TOFU, the host key fingerprint is pinned:

- Every subsequent connection or test compares the server's presented host key against `ssh_connections.host_key_fingerprint`
- Comparison is exact string match of SHA-256 fingerprint

### Mismatch Handling

When a host key mismatch is detected:

1. **Connection immediately refused** — no data exchanged beyond the key exchange
2. API returns `409 Conflict` with both fingerprints:
   ```json
   {
     "result": "host_key_changed",
     "old_fingerprint": "SHA256:abc123...",
     "new_fingerprint": "SHA256:def456...",
     "message": "The server's host key has changed."
   }
   ```
3. User must explicitly accept the new key (re-send test with `{ "accept_host_key": true }`)
4. On acceptance: old fingerprint replaced with new one, audit log entry with both fingerprints
5. **Audit log detail includes:**
   - `action: "connection.host_key_changed"`
   - `detail: { old_fingerprint, new_fingerprint, user_accepted: true }`

### Server-Side Known Hosts

- Each connection's host key is maintained server-side — no global `known_hosts` file
- Host key stored per-connection in the database, not in filesystem
- ControlMaster invocations use a temporary known_hosts file with only the pinned key:
  ```
  ssh -o UserKnownHostsFile=/tmp/clawdfather/<session_id>.known_hosts ...
  ```
- Temporary known_hosts file deleted after ControlMaster is established
- **Never** `StrictHostKeyChecking=no` in production

---

## 4.3 Password Handling Policy

### v1: No Password Auth

**Clawdfather v1 does not support password-based SSH authentication.** Ed25519 keys only.

Rationale:
- Keys are cryptographically stronger than passwords
- Keys can be rotated and revoked programmatically
- Keys don't require transmitting secrets over the wire during auth
- Eliminates password storage risk entirely

### v2 Consideration: Password Fallback

If password SSH auth is added in a future phase, these requirements must be met:

| Requirement | Implementation |
|-------------|---------------|
| Encryption at rest | AES-256-GCM with same per-account KEK scheme as private keys |
| Never logged | Passwords excluded from all log output, audit log detail, and error messages |
| Never returned in API | API responses never include passwords, even masked |
| TTL | Maximum 90-day storage. After 90 days, password cleared and user prompted to re-enter |
| Re-entry on rotation | If master key or KEK rotates, passwords must be re-entered (not re-encrypted from old ciphertext without user verification) |
| Transport | HTTPS only. Password transmitted in request body, never in URL/query params |
| Memory handling | Password zeroed from memory after encryption. Use `Buffer.alloc()` + `buffer.fill(0)` pattern |

---

## 4.4 OAuth Token/Session Hardening

### CSRF Protection (State Parameter)

```
                 ┌─────────┐           ┌──────────┐           ┌────────┐
                 │  Client  │           │  Server   │           │ GitHub │
                 └────┬─────┘           └─────┬─────┘           └───┬────┘
                      │                       │                     │
  1. POST /auth/oauth/github/start            │                     │
                      │──────────────────────►│                     │
                      │                       │                     │
                      │  state = CSPRNG(32)   │                     │
                      │  cookie = HMAC(state) │                     │
                      │◄──────────────────────│                     │
                      │  Set-Cookie: HttpOnly │                     │
                      │  + authorize_url      │                     │
                      │                       │                     │
  2. Redirect to GitHub                       │                     │
                      │───────────────────────────────────────────►│
                      │                       │                     │
  3. User authorizes                          │                     │
                      │◄──────────────────────────────────────────│
                      │  code + state         │                     │
                      │                       │                     │
  4. GET /callback?code=...&state=...         │                     │
                      │──────────────────────►│                     │
                      │  + cookie             │                     │
                      │                       │                     │
                      │  Validate:            │                     │
                      │  HMAC(state) == cookie │                     │
                      │                       │                     │
  5. Exchange code                            │                     │
                      │                       │────────────────────►│
                      │                       │◄────────────────────│
                      │                       │  access_token       │
                      │                       │                     │
  6. Issue app session token                  │                     │
                      │◄──────────────────────│                     │
                      │  { token, account }   │                     │
```

**State parameter details:**
- 32 bytes from `crypto.randomBytes(32)`, hex-encoded (64 chars)
- Stored in signed, `HttpOnly`, `Secure`, `SameSite=Lax` cookie
- Cookie value: `HMAC-SHA256(state, server_signing_key)` — server verifies on callback
- State expires after 10 minutes
- Each state is single-use (deleted after callback processing)

### PKCE (Proof Key for Code Exchange)

For mobile/public clients where the client secret cannot be securely stored:

- `code_verifier`: 43-128 character high-entropy random string, generated client-side
- `code_challenge`: `BASE64URL(SHA256(code_verifier))`, sent with authorization request
- `code_challenge_method`: `S256`
- Server stores `code_verifier` keyed to state, validates on callback when exchanging code

### App Session Token Management

| Property | Value |
|----------|-------|
| Token format | `clf_` prefix + 32 bytes CSPRNG, base64url-encoded (total ~47 chars) |
| Storage in DB | SHA-256 hash of token only (`token_hash` column). Raw token never stored |
| Transport | `Authorization: Bearer clf_...` header. HTTPS only |
| Client storage | iOS Keychain / Android Keystore (hardware-backed if available) |
| Default TTL | 30 days from creation |
| Sliding expiry | Extended by 30 days on each API call (capped at 90 days max from creation) |
| Revocation | Immediate on `DELETE /auth/session`. Token hash deleted from DB |

### Brute-Force Mitigations

| Target | Threshold | Action |
|--------|-----------|--------|
| OAuth callback (`/auth/oauth/*/callback`) | >20 attempts/hour per IP | Block IP for 1 hour. Log alert |
| Token validation (any authenticated endpoint) | >10 failed token validations/10 min per IP | Block IP for 15 minutes |
| Token validation per account | >10 failed attempts/10 min for same `account_id` | Temporary account lock (15 min). Notification sent |
| Session start | >10/hour per account | Rate limit (429 response) |
| Connection test | >5/min per connection | Rate limit (429 response) |

### Replay Prevention

- **Nonces:** All state-changing endpoints accept an optional `X-Idempotency-Key` header. Server stores used keys for 24 hours (keyed to account_id). Duplicate requests return the original response.
- **Session start:** Mandatory idempotency key to prevent accidental double-start.
- **HTTPS:** All traffic encrypted in transit — no plaintext API calls. HSTS header with `max-age=31536000; includeSubDomains`.
- **Timestamp validation:** Requests older than 5 minutes rejected (based on optional `X-Request-Timestamp` header, validated against server clock).

---

## 4.5 Audit Logging & Incident Response

### What Gets Logged

**Every security-relevant event**, no exceptions:

| Category | Events |
|----------|--------|
| **Authentication** | OAuth start, callback (success/failure), session create, session revoke, failed token validations |
| **Key management** | Key generate, rotate (start/complete), revoke, decrypt (for session start) |
| **Connections** | Create, update, test (success/failure), delete, host key change |
| **Sessions** | Start (success/failure), heartbeat, close (user/timeout/error/server), reconnect |
| **Security events** | Rate limit hit, brute-force lockout, IP block, host key mismatch, revoked key usage attempt |
| **API errors** | 5xx errors with request context (no credentials in logs) |

### Log Format

Dual output: structured JSON to stdout (for log aggregator) + DB insert (for user-facing audit trail).

**Structured log entry:**
```json
{
  "timestamp": "2026-02-21T17:00:00.123Z",
  "level": "info",
  "event": "session.start",
  "account_id": "550e8400-e29b-41d4-a716-446655440000",
  "actor": "account:550e8400-e29b-41d4-a716-446655440000",
  "target_type": "session_lease",
  "target_id": "880e8400-e29b-41d4-a716-446655440003",
  "result": "ok",
  "ip": "203.0.113.42",
  "user_agent": "ClawdfatherApp/1.0 iOS/17.0",
  "detail": {
    "connection_id": "770e8400-e29b-41d4-a716-446655440002",
    "host": "192.168.1.100",
    "latency_ms": 342
  },
  "trace_id": "abc123def456"
}
```

**Sensitive data exclusion checklist:**
- Private keys: never logged
- OAuth tokens: never logged
- Session tokens: never logged (only hash prefix for correlation: `clf_a1b2...`)
- Passwords: never logged
- Host addresses: logged (not sensitive — needed for incident investigation)

### Retention Policy

| Tier | Storage | Retention | Purpose |
|------|---------|-----------|---------|
| **Hot** | PostgreSQL `audit_log` table (partitioned by month) | 90 days | User-facing audit trail, recent incident investigation |
| **Warm** | S3/GCS (gzipped JSONL, server-side encrypted) | 1 year | Compliance, extended investigation |
| **Cold** | Glacier/Coldline | 7 years (if required by compliance) | Legal hold |

**Deletion:** After retention period, data is permanently deleted. No backup retention beyond policy.

### Incident Response Automation

| Trigger | Threshold | Response |
|---------|-----------|----------|
| Failed auth burst | >5 failed OAuth callbacks in 10 min from same IP | Alert to ops channel (Slack/PagerDuty). Temporary IP block (1 hour). Log incident |
| Failed token validation burst | >10 failed validations in 10 min for same account | Alert. Temporary account lock (15 min). Email notification to account owner |
| Host key change | Any host key mismatch event | Alert to ops channel. Logged with high priority. Connection blocked until user re-approves |
| Session error spike | >5 session errors in 10 min | Alert. Health check triggered. Investigate SSH infrastructure |
| Rate limit saturation | Any rate limit bucket consistently >80% full | Alert (warning severity). Review if limits need adjustment |
| Revoked key usage | Any attempt to use a revoked key | Alert. Session terminated immediately. Audit log with full context |

**Alert channels:**
- P1 (private key, auth): PagerDuty → on-call engineer
- P2 (host key, session error): Slack ops channel
- P3 (rate limits, routine): Slack ops channel (low priority)

---

## 4.6 Threat Model

| # | Threat | Vector | Likelihood | Impact | Mitigation |
|---|--------|--------|------------|--------|------------|
| T1 | **Private key theft** | Database breach exposes `private_key_enc` column | Low | **Critical** — attacker gains SSH access to all user servers | Keys encrypted at rest with AES-256-GCM. KEK derived from master key in HSM/KMS. DB breach alone yields only ciphertext. HSM breach required for plaintext |
| T2 | **Session hijack** | Bearer token stolen via XSS, network sniffing, or device compromise | Medium | **High** — attacker controls active sessions | HTTPS only (HSTS). Token stored hashed in DB. Short-ish TTL (30 days sliding). Secure client storage (Keychain/Keystore). Session list UI for user to spot unknown sessions |
| T3 | **MITM / host key swap** | Attacker intercepts SSH connection, presents different host key | Low | **High** — attacker controls command execution | Host key pinning (TOFU). Strict mismatch rejection (409). No silent key acceptance. User must explicitly re-approve changed keys. All changes audit-logged |
| T4 | **OAuth token abuse** | GitHub access token leaked via provider breach or stolen from DB | Low | **Medium** — attacker can read user's GitHub profile (minimal scopes) | Minimal scopes (`read:user`, `user:email`). Token encrypted at rest. Token not stored raw. Token not used after initial account creation (only for refresh). GitHub token revocation on account delete |
| T5 | **Brute force API** | Automated requests to auth/session endpoints | Medium | **Medium** — account lockout, resource exhaustion | Rate limits on all sensitive endpoints. IP-based blocking. Account lockout after threshold. CAPTCHA escalation for persistent abuse |
| T6 | **Replay attack** | Captured HTTPS request replayed | Low | **Medium** — duplicate session start, duplicate operations | Idempotency keys on state-changing endpoints. Session start requires unique idempotency key. HTTPS prevents capture (requires TLS compromise). Nonce replay detection (24-hour window) |
| T7 | **SSH key misuse** | Compromised remote server uses Clawdfather key to pivot | Medium | **High** — lateral movement if key is shared across servers | Per-account keys (not per-server, but one user ≠ shared keys between users). Key revocation terminates sessions within 60s. Audit log tracks all key usage. Recommendation: use different keys per environment (prod/staging) |
| T8 | **Concurrent session abuse** | Attacker or compromised account starts many sessions to mine resources | Low | **Medium** — resource exhaustion on Clawdfather server | Configurable session limit per account (default 3). Rate limit on session start (10/hour). Monitoring for unusual session patterns |
| T9 | **ControlMaster socket hijack** | Local attacker on Clawdfather server accesses socket file | Low | **Critical** — direct SSH access to user's server | Socket created with mode 0600. Socket path includes session UUID (unpredictable). Socket deleted on session close. Server hardening (no shared hosting). Process isolation recommended (containers) |
| T10 | **Temp key file exposure** | Private key temp file read by another process during brief window | Low | **Critical** — private key plaintext exposed | File created with mode 0600. File deleted immediately after ControlMaster socket established (typically <2 seconds). Directory `/tmp/clawdfather/` created with mode 0700. Consider `memfd_create` on Linux to avoid filesystem entirely (Phase 3) |
| T11 | **Denial of service** | Flood of connection tests or session starts | Medium | **Medium** — service unavailable for legitimate users | Rate limiting at multiple levels (IP, account, endpoint). Connection test has 15s timeout (prevents long-running probes). SSH ControlMaster has 10s connect timeout. Health endpoint for monitoring |
| T12 | **Account takeover via OAuth** | Attacker compromises user's GitHub account | Low | **Critical** — full access to all Clawdfather connections and sessions | Out of Clawdfather's direct control. Mitigations: session list UI for anomaly detection. Email notification on new login. Biometric lock on app prevents device-based takeover. Account lock capability for admin response |

### Trust Boundaries

```
┌─────────────────────────────────────────────────────────────┐
│                    USER'S MOBILE DEVICE                      │
│  ┌──────────────┐                                           │
│  │ Clawdfather   │  Token in Keychain                       │
│  │ App           │  Biometric gate                          │
│  └──────┬───────┘                                           │
└─────────┼───────────────────────────────────────────────────┘
          │ HTTPS (TLS 1.3)
          │ Bearer token
══════════╪═══════════════════════════════════════════════════
          │           TRUST BOUNDARY: Internet
══════════╪═══════════════════════════════════════════════════
┌─────────┼───────────────────────────────────────────────────┐
│         ▼          CLAWDFATHER SERVER                        │
│  ┌──────────────┐  ┌────────────┐  ┌─────────────────┐     │
│  │ API Server    │──│ PostgreSQL │  │ KMS / HSM       │     │
│  │ (Node.js)    │  │ (encrypted)│  │ (master key)    │     │
│  └──────┬───────┘  └────────────┘  └─────────────────┘     │
│         │                                                    │
│  ┌──────┴───────┐                                           │
│  │ ControlMaster │  Private key in memory only               │
│  │ SSH Process   │  Socket file (0600, session UUID path)    │
│  └──────┬───────┘                                           │
└─────────┼───────────────────────────────────────────────────┘
          │ SSH (Ed25519 auth)
══════════╪═══════════════════════════════════════════════════
          │           TRUST BOUNDARY: Network
══════════╪═══════════════════════════════════════════════════
┌─────────┼───────────────────────────────────────────────────┐
│         ▼          USER'S REMOTE SERVER                      │
│  ┌──────────────┐                                           │
│  │ sshd          │  authorized_keys with Clawdfather pubkey │
│  │ (target)      │  Host key pinned in Clawdfather DB       │
│  └──────────────┘                                           │
└─────────────────────────────────────────────────────────────┘
```

### Security Invariants (Must Always Hold)

1. **Private keys are never stored in plaintext** — always AES-256-GCM encrypted at rest
2. **Bearer tokens are never stored raw in DB** — only SHA-256 hashes
3. **Host keys are never silently accepted** — user must approve (TOFU or mismatch re-approval)
4. **No SSH password auth in v1** — Ed25519 keys are the only authentication mechanism
5. **Revoked keys terminate sessions within 60 seconds** — enforced by heartbeat checker
6. **All security events are logged** — no silent failures, no unlogged auth attempts
7. **Rate limits exist on all unauthenticated endpoints** — no open-ended request capacity
8. **Temp key files exist for <5 seconds** — written with mode 0600, deleted after use
9. **HTTPS everywhere** — no plaintext HTTP endpoints in production (HSTS enforced)
10. **OAuth state is single-use and time-limited** — prevents CSRF and replay
