# Data Model & Schema Draft

> Clawdfather — Mobile-First Account-Based SSH Orchestration

---

## Tables

### accounts

Core identity table. One row per Clawdfather user.

```sql
CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX accounts_email_idx ON accounts(email) WHERE email IS NOT NULL;
CREATE INDEX accounts_is_active_idx ON accounts(is_active) WHERE is_active = TRUE;
```

**Notes:**
- `email` is nullable — populated from OAuth provider if available, not required.
- `is_active` supports soft-disable of accounts without deletion (admin action, abuse mitigation).
- `last_seen_at` updated on every authenticated API call (debounced to once per minute to avoid write amplification).

---

### oauth_identities

Links external OAuth providers to Clawdfather accounts. Supports multiple providers per account.

```sql
CREATE TABLE oauth_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,                    -- 'github', 'google', etc.
  provider_user_id TEXT NOT NULL,
  provider_username TEXT,
  provider_email TEXT,
  access_token TEXT,                         -- ENCRYPTED AT REST
  refresh_token TEXT,                        -- ENCRYPTED AT REST
  token_expires_at TIMESTAMPTZ,
  scopes TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_user_id)
);

CREATE INDEX oauth_identities_account_id_idx ON oauth_identities(account_id);
```

**Notes:**
- `UNIQUE (provider, provider_user_id)` prevents duplicate links. One GitHub account → one Clawdfather account.
- `access_token` and `refresh_token` encrypted with AES-256-GCM using per-account KEK (see Security Model doc).
- `scopes` stored as array for audit — verify minimum scopes on each OAuth refresh.
- `updated_at` set on token refresh.

---

### agent_keypairs

Ed25519 keypairs generated server-side for SSH authentication. One or more per account.

```sql
CREATE TABLE agent_keypairs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT 'default',
  algorithm TEXT NOT NULL DEFAULT 'ed25519',
  public_key TEXT NOT NULL,                  -- plain OpenSSH format, safe to store/display
  private_key_enc TEXT NOT NULL,             -- ENCRYPTED AT REST (AES-256-GCM)
  fingerprint TEXT NOT NULL,                 -- SHA-256 base64 fingerprint
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (account_id, label)
);

CREATE INDEX agent_keypairs_account_id_idx ON agent_keypairs(account_id);
CREATE INDEX agent_keypairs_fingerprint_idx ON agent_keypairs(fingerprint);
CREATE INDEX agent_keypairs_active_idx ON agent_keypairs(account_id, is_active) WHERE is_active = TRUE;
```

**Notes:**
- `private_key_enc` contains the AES-256-GCM ciphertext of the PEM-encoded private key. Format: `<base64(nonce)>:<base64(ciphertext)>:<base64(auth_tag)>`.
- `fingerprint` is the SHA-256 fingerprint of the public key in base64, matching OpenSSH `ssh-keygen -l` output format.
- `UNIQUE (account_id, label)` ensures one active key per label per account. Rotation creates a new row with the same label after revoking the old one.
- Maximum 5 active keypairs per account (enforced at application level).

---

### ssh_connections

Saved SSH connection configurations. Users can have multiple.

```sql
CREATE TABLE ssh_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  keypair_id UUID NOT NULL REFERENCES agent_keypairs(id),
  label TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  host_key_fingerprint TEXT,                 -- pinned after first verified connection
  last_tested_at TIMESTAMPTZ,
  last_test_result TEXT,                     -- 'ok' | 'failed' | 'timeout' | 'host_key_mismatch'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,                    -- soft delete
  UNIQUE (account_id, label)
);

CREATE INDEX ssh_connections_account_id_idx ON ssh_connections(account_id) WHERE deleted_at IS NULL;
CREATE INDEX ssh_connections_keypair_id_idx ON ssh_connections(keypair_id);
```

**Notes:**
- `host_key_fingerprint` is NULL until first successful TOFU verification. Format: `SHA256:<base64>`.
- `deleted_at` enables soft delete. All queries filter `WHERE deleted_at IS NULL` by default.
- `UNIQUE (account_id, label)` scoped to account — users pick unique labels for their connections.
- `last_test_result` enum enforced at application level. NULL if never tested.
- `port` constrained to 1-65535 at application level.

---

### session_leases

Tracks active and historical agent sessions. One row per session start attempt.

```sql
CREATE TABLE session_leases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  connection_id UUID NOT NULL REFERENCES ssh_connections(id),
  keypair_id UUID NOT NULL REFERENCES agent_keypairs(id),
  status TEXT NOT NULL DEFAULT 'pending',    -- 'pending' | 'active' | 'closed' | 'error'
  agent_session_id TEXT,                     -- OpenClaw agent session ID
  started_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  close_reason TEXT,                         -- 'user' | 'timeout' | 'error' | 'server_closed'
  last_heartbeat_at TIMESTAMPTZ,
  error_detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX session_leases_account_id_idx ON session_leases(account_id);
CREATE INDEX session_leases_connection_id_idx ON session_leases(connection_id);
CREATE INDEX session_leases_status_idx ON session_leases(status) WHERE status IN ('pending', 'active');
CREATE INDEX session_leases_heartbeat_idx ON session_leases(last_heartbeat_at) WHERE status = 'active';
```

**Notes:**
- `status` transitions are strictly controlled (see state machine below).
- `agent_session_id` is the OpenClaw runtime session identifier, set once the agent is spawned.
- `last_heartbeat_at` updated by WebSocket pings from the client (every 30s) and by API calls.
- `error_detail` stores structured error info (SSH error string, exit code, etc.) for debugging.
- No CASCADE on `account_id` or `connection_id` — sessions are historical records.

---

### app_sessions

Web/mobile authentication sessions. Bearer token management.

```sql
CREATE TABLE app_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,           -- SHA-256 of bearer token (NEVER store raw)
  device_name TEXT,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX app_sessions_account_id_idx ON app_sessions(account_id);
CREATE INDEX app_sessions_expires_at_idx ON app_sessions(expires_at) WHERE revoked_at IS NULL;
CREATE INDEX app_sessions_token_hash_idx ON app_sessions(token_hash);
```

**Notes:**
- Raw bearer token is **never stored**. Only SHA-256 hash. Token validation: hash incoming token → lookup by `token_hash`.
- `expires_at` set to `NOW() + 30 days` on creation. Sliding expiry: extended on each use (up to max 90 days from creation).
- `revoked_at` set on explicit logout or admin revocation. Revoked sessions rejected immediately.
- `device_name` extracted from User-Agent or provided by client for "Active Sessions" UI.
- Expired/revoked sessions cleaned up by background job after 30 days.

---

### audit_log

Append-only audit trail for security-relevant events.

```sql
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  account_id UUID REFERENCES accounts(id),
  actor TEXT,                                -- 'account:<id>' or 'system'
  action TEXT NOT NULL,                      -- e.g. 'connection.test', 'session.start'
  target_type TEXT,                          -- 'ssh_connection', 'session_lease', etc.
  target_id UUID,
  ip_address INET,
  result TEXT,                               -- 'ok' | 'failed'
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partition by month in production for scale
CREATE INDEX audit_log_account_id_idx ON audit_log(account_id);
CREATE INDEX audit_log_created_at_idx ON audit_log(created_at DESC);
CREATE INDEX audit_log_action_idx ON audit_log(action);
CREATE INDEX audit_log_target_idx ON audit_log(target_type, target_id);
```

**Notes:**
- `BIGSERIAL` for high-volume append workload — IDs are monotonic, no UUID overhead.
- `actor` distinguishes user-initiated vs. system-initiated events (e.g., timeout cleanup).
- `detail` is JSONB for flexible event-specific data (error messages, IP addresses, latency, etc.).
- **Partition by month** in production: `CREATE TABLE audit_log (...) PARTITION BY RANGE (created_at);` with monthly child tables.
- Retention: 90 days hot in PostgreSQL, then archived to S3/GCS as gzipped JSONL.

**Canonical action values:**

| Action | Trigger |
|--------|---------|
| `auth.oauth.start` | OAuth flow initiated |
| `auth.oauth.callback` | OAuth callback processed |
| `auth.session.create` | App session token issued |
| `auth.session.revoke` | User logged out / token revoked |
| `key.generate` | New keypair created |
| `key.rotate` | Keypair rotated (old revoked, new created) |
| `key.revoke` | Keypair explicitly revoked |
| `connection.create` | SSH connection saved |
| `connection.update` | SSH connection edited |
| `connection.test` | Connection test executed |
| `connection.delete` | SSH connection soft-deleted |
| `session.start` | Agent session started |
| `session.heartbeat` | Session heartbeat received |
| `session.close` | Agent session closed |
| `session.timeout` | Session expired due to inactivity |
| `session.error` | Session encountered an error |

---

## Indexes Summary

| Table | Index | Columns | Justification |
|-------|-------|---------|---------------|
| `accounts` | `accounts_email_idx` | `email` (partial: NOT NULL) | Email lookup for dedup during OAuth |
| `accounts` | `accounts_is_active_idx` | `is_active` (partial: TRUE) | Filter active accounts quickly |
| `oauth_identities` | `oauth_identities_account_id_idx` | `account_id` | List identities for an account |
| `oauth_identities` | UNIQUE constraint | `(provider, provider_user_id)` | Prevent duplicate OAuth links |
| `agent_keypairs` | `agent_keypairs_account_id_idx` | `account_id` | List keys for an account |
| `agent_keypairs` | `agent_keypairs_fingerprint_idx` | `fingerprint` | Lookup by fingerprint for verification |
| `agent_keypairs` | `agent_keypairs_active_idx` | `(account_id, is_active)` (partial: TRUE) | List active keys for account |
| `ssh_connections` | `ssh_connections_account_id_idx` | `account_id` (partial: not deleted) | List active connections for account |
| `ssh_connections` | `ssh_connections_keypair_id_idx` | `keypair_id` | Check if key is in use before revocation |
| `session_leases` | `session_leases_account_id_idx` | `account_id` | List sessions for account |
| `session_leases` | `session_leases_connection_id_idx` | `connection_id` | Check active sessions before connection delete |
| `session_leases` | `session_leases_status_idx` | `status` (partial: pending/active) | Find active sessions for cleanup |
| `session_leases` | `session_leases_heartbeat_idx` | `last_heartbeat_at` (partial: active) | Orphan cleanup job queries this |
| `app_sessions` | `app_sessions_account_id_idx` | `account_id` | List sessions for "Active Sessions" UI |
| `app_sessions` | `app_sessions_expires_at_idx` | `expires_at` (partial: not revoked) | Cleanup expired sessions |
| `app_sessions` | `app_sessions_token_hash_idx` | `token_hash` | Token validation lookup (primary path) |
| `audit_log` | `audit_log_account_id_idx` | `account_id` | Account audit trail queries |
| `audit_log` | `audit_log_created_at_idx` | `created_at DESC` | Pagination (most recent first) |
| `audit_log` | `audit_log_action_idx` | `action` | Filter by event type |
| `audit_log` | `audit_log_target_idx` | `(target_type, target_id)` | Audit trail for specific resources |

---

## Lifecycle State Diagrams

### session_leases.status

```
                  ┌──────────┐
                  │ pending  │
                  └────┬─────┘
                       │
              SSH connect + agent spawn
                       │
              ┌────────┴────────┐
              │                 │
              ▼                 ▼
        ┌──────────┐     ┌──────────┐
        │  active  │     │  error   │
        └────┬─────┘     └──────────┘
             │                 ▲
    ┌────────┼────────┐        │
    │        │        │        │
    ▼        ▼        ▼        │
  user    timeout   server   runtime
  close   (idle)    crash    failure
    │        │        │        │
    └────────┼────────┘        │
             │                 │
             ▼                 │
        ┌──────────┐           │
        │  closed  │           │
        └──────────┘           │
                               │
    Note: pending → error occurs when
    SSH connect or agent spawn fails
```

**Transition rules:**

| From | To | Trigger | Sets |
|------|----|---------|------|
| `pending` | `active` | SSH ControlMaster established + agent spawned | `started_at`, `last_heartbeat_at` |
| `pending` | `error` | SSH connect failure or agent spawn failure | `error_detail`, `closed_at` |
| `active` | `closed` | User closes session (`DELETE /sessions/:id`) | `closed_at`, `close_reason='user'` |
| `active` | `closed` | Idle timeout (no heartbeat for 30 min) | `closed_at`, `close_reason='timeout'` |
| `active` | `closed` | Server-initiated close (ControlMaster exit) | `closed_at`, `close_reason='server_closed'` |
| `active` | `error` | Runtime error during session | `closed_at`, `close_reason='error'`, `error_detail` |

**Invariants:**
- `closed` and `error` are terminal states — no further transitions.
- `started_at` is only set on `pending → active`.
- `closed_at` is set on any transition to `closed` or `error`.

---

### agent_keypairs Lifecycle

```
        ┌──────────┐
        │  active  │ ◄── created via POST /api/v1/keys
        └────┬─────┘
             │
        key rotation triggered
             │
             ▼
        ┌──────────┐
        │ rotated  │  (is_active=false, rotated_at set)
        └────┬─────┘
             │
        7-day grace period expires
        (or immediate if no active sessions)
             │
             ▼
        ┌──────────┐
        │ revoked  │  (revoked_at set)
        └──────────┘
```

**State encoding** (no explicit `status` column — derived from fields):

| State | `is_active` | `rotated_at` | `revoked_at` |
|-------|-------------|--------------|--------------|
| Active | `TRUE` | `NULL` | `NULL` |
| Rotated | `FALSE` | `<timestamp>` | `NULL` |
| Revoked | `FALSE` | any | `<timestamp>` |

**Rules:**
- Active → Rotated: triggered by key rotation. New key created with same label. Old key's `is_active` set to FALSE, `rotated_at` set.
- Rotated → Revoked: after 7-day grace period (allows active sessions using old key to wind down). Background job checks and revokes.
- Active → Revoked: explicit user revocation via `DELETE /api/v1/keys/:id`. Immediate if no active sessions; otherwise fails with 409 until sessions are closed.
- Revoked keys are never reactivated.

---

### ssh_connections Lifecycle

```
        ┌──────────┐
        │  draft   │ ◄── created via POST /api/v1/connections
        └────┬─────┘     (host_key_fingerprint = NULL,
             │             last_test_result = NULL)
             │
        POST /connections/:id/test → success
             │
             ▼
        ┌──────────┐
        │  tested  │  (host_key_fingerprint set,
        └────┬─────┘   last_test_result = 'ok')
             │
        DELETE /connections/:id
             │
             ▼
        ┌──────────┐
        │ deleted  │  (deleted_at set, soft delete)
        └──────────┘
```

**State encoding** (no explicit `status` column — derived from fields):

| State | `host_key_fingerprint` | `last_test_result` | `deleted_at` |
|-------|------------------------|-------------------|-------------|
| Draft | `NULL` | `NULL` | `NULL` |
| Tested (success) | `<fingerprint>` | `'ok'` | `NULL` |
| Tested (failure) | `NULL` or previous | `'failed'` / `'timeout'` / `'host_key_mismatch'` | `NULL` |
| Deleted | any | any | `<timestamp>` |

**Rules:**
- Draft → Tested: first successful connection test pins the host key.
- Tested → Tested: subsequent tests update `last_tested_at` and `last_test_result`. Host key re-pinned only if user explicitly accepts change (409 flow).
- Any non-deleted → Deleted: soft delete via `DELETE`. Blocked if active session_leases exist for this connection.
- Deleted connections are excluded from all list queries.

---

## Security Notes Per Sensitive Field

| Field | Table | Sensitivity | Protection Mechanism | Notes |
|-------|-------|-------------|---------------------|-------|
| `access_token` | `oauth_identities` | **High** | AES-256-GCM encryption at rest, per-account KEK derived via HKDF from master key + account_id | Never returned in API responses. Decrypted only when making GitHub API calls (token refresh, user info fetch) |
| `refresh_token` | `oauth_identities` | **High** | AES-256-GCM encryption at rest, same KEK as access_token | Never returned in API responses. Used only server-side for token refresh |
| `private_key_enc` | `agent_keypairs` | **Critical** | AES-256-GCM encryption at rest, per-account KEK. Plaintext exists only in memory during SSH connect, written to temp file (mode 0600) for ControlMaster, deleted immediately after socket established | Loss = full SSH access to user's servers. KEK stored in HSM/KMS in production |
| `public_key` | `agent_keypairs` | **Low** | Stored plaintext | Public by design. Displayed to users, installed on servers. No confidentiality requirement |
| `token_hash` | `app_sessions` | **Medium** | SHA-256 hash of bearer token. Raw token exists only in transit to client | One-way hash — DB breach does not reveal usable tokens. Brute-force mitigated by token entropy (32 bytes = 256 bits) |
| `host_key_fingerprint` | `ssh_connections` | **Low** | Stored plaintext | Public server identity. Used for TOFU pinning verification. Tampering would require DB write access |
| `ip_address` | `app_sessions`, `audit_log` | **Medium** | Stored plaintext | PII under GDPR. Retained for 90 days (audit), then anonymized or deleted. Used for brute-force detection |
| `detail` | `audit_log` | **Medium** | Stored as JSONB, no encryption | May contain error messages with hostnames/IPs. Never contains credentials, keys, or tokens. Sanitize before write |
| `email` | `accounts` | **Medium** | Stored plaintext | PII. Used for account recovery and notifications. Deletion on account close required |
| `provider_email` | `oauth_identities` | **Medium** | Stored plaintext | PII from OAuth provider. May differ from `accounts.email`. Same retention policy |
| `device_name`, `user_agent` | `app_sessions` | **Low** | Stored plaintext | Browser/device info. Used for "Active Sessions" display. Minor PII, cleaned up with session |
