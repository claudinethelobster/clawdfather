# API Surface Draft

> Clawdfather — Mobile-First Account-Based SSH Orchestration

---

## Conventions

- **Base path:** `/api/v1`
- **Auth:** Bearer token in `Authorization: Bearer <token>` header (except `/auth/*` endpoints)
- **Content-Type:** `application/json` for all request and response bodies
- **Error format:** `{ "error": { "code": "<machine_readable>", "message": "<human_readable>", "detail": {} } }`
- **Pagination:** `?limit=N&offset=N` (default limit=20, max limit=100)
- **Timestamps:** ISO 8601 with timezone (e.g., `2026-02-21T15:30:00Z`)
- **IDs:** UUID v4

---

## Auth & Session Endpoints

### POST /api/v1/auth/oauth/github/start

Initiates the GitHub OAuth authorization flow.

| Field | Value |
|-------|-------|
| **Auth** | None |
| **Rate limit** | 10/minute per IP |
| **Idempotent** | No (generates unique state each call) |

**Request body:**

```json
{
  "redirect_uri": "https://app.clawdfather.io/auth/callback"
}
```

**Response (200):**

```json
{
  "authorize_url": "https://github.com/login/oauth/authorize?client_id=...&state=...&scope=read:user,user:email&code_challenge=...&code_challenge_method=S256",
  "state": "eyJ..."
}
```

**Side effects:**
- Generates 32-byte CSPRNG state parameter
- Sets signed `HttpOnly` cookie with state hash (CSRF protection)
- Generates PKCE `code_verifier`, stores server-side keyed to state

**Errors:**

| Status | Code | When |
|--------|------|------|
| 429 | `rate_limited` | >10 requests/minute from this IP |

---

### GET /api/v1/auth/oauth/github/callback

OAuth callback handler. Exchanges authorization code for tokens, creates/links account, issues app session.

| Field | Value |
|-------|-------|
| **Auth** | None (state cookie validated) |
| **Rate limit** | 20/hour per IP |
| **Idempotent** | No |

**Query parameters:**
- `code` — GitHub authorization code
- `state` — State parameter for CSRF validation

**Response (200):**

```json
{
  "token": "clf_a1b2c3d4e5f6....",
  "account": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "display_name": "samjones",
    "email": "sam@example.com"
  },
  "expires_at": "2026-03-23T15:30:00Z"
}
```

**Side effects:**
- Validates state against cookie hash
- Validates PKCE code_verifier
- Exchanges code for GitHub access token
- Creates `accounts` + `oauth_identities` rows (or links to existing account)
- Generates 32-byte CSPRNG session token, stores SHA-256 hash in `app_sessions`
- Audit log: `auth.oauth.callback`

**Errors:**

| Status | Code | When |
|--------|------|------|
| 400 | `invalid_state` | State mismatch (CSRF) or expired |
| 400 | `invalid_code` | GitHub rejected the authorization code |
| 429 | `rate_limited` | >20 callbacks/hour from this IP |
| 502 | `github_unavailable` | GitHub API unreachable |

---

### DELETE /api/v1/auth/session

Revokes the current app session token (logout).

| Field | Value |
|-------|-------|
| **Auth** | Required |
| **Rate limit** | None |
| **Idempotent** | Yes (revoking already-revoked session returns 200) |

**Request body:** None

**Response (200):**

```json
{
  "ok": true
}
```

**Side effects:**
- Sets `revoked_at` on the `app_sessions` row
- Audit log: `auth.session.revoke`

**Errors:**

| Status | Code | When |
|--------|------|------|
| 401 | `unauthorized` | Missing or invalid token |

---

### GET /api/v1/auth/me

Returns the current authenticated account's information.

| Field | Value |
|-------|-------|
| **Auth** | Required |
| **Rate limit** | None |
| **Idempotent** | Yes |

**Response (200):**

```json
{
  "account": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "display_name": "samjones",
    "email": "sam@example.com",
    "created_at": "2026-02-20T10:00:00Z",
    "oauth_providers": ["github"]
  }
}
```

**Errors:**

| Status | Code | When |
|--------|------|------|
| 401 | `unauthorized` | Missing or invalid token |

---

## Key Provisioning Endpoints

### GET /api/v1/keys

List all keypairs for the authenticated account.

| Field | Value |
|-------|-------|
| **Auth** | Required |
| **Rate limit** | None |
| **Idempotent** | Yes |

**Response (200):**

```json
{
  "keypairs": [
    {
      "id": "660e8400-e29b-41d4-a716-446655440001",
      "label": "default",
      "fingerprint": "SHA256:uNiRzE3rGluHDBGPmR0mVz07MiiWkOsaFXLRs9oag5Q",
      "public_key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGn... clawdfather:default",
      "algorithm": "ed25519",
      "created_at": "2026-02-20T10:01:00Z",
      "is_active": true
    }
  ]
}
```

**Notes:**
- Returns all keypairs (active, rotated, revoked) for transparency.
- Private key is **never** returned.

---

### POST /api/v1/keys

Generate a new Ed25519 keypair for the account.

| Field | Value |
|-------|-------|
| **Auth** | Required |
| **Rate limit** | 5/hour per account |
| **Idempotent** | Yes (on label — if label exists and is active, returns existing keypair) |

**Request body:**

```json
{
  "label": "default"
}
```

`label` defaults to `"default"` if omitted.

**Response (201):**

```json
{
  "keypair": {
    "id": "660e8400-e29b-41d4-a716-446655440001",
    "label": "default",
    "fingerprint": "SHA256:uNiRzE3rGluHDBGPmR0mVz07MiiWkOsaFXLRs9oag5Q",
    "public_key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGn... clawdfather:default",
    "algorithm": "ed25519",
    "created_at": "2026-02-20T10:01:00Z"
  }
}
```

**Response (200) — idempotent hit (label exists and active):**

Same body as 201 but with existing keypair data.

**Side effects:**
- Generates Ed25519 keypair via `crypto.generateKeyPair('ed25519')`
- Encrypts private key with AES-256-GCM using per-account KEK
- Stores in `agent_keypairs`
- Audit log: `key.generate`

**Errors:**

| Status | Code | When |
|--------|------|------|
| 401 | `unauthorized` | Missing or invalid token |
| 409 | `key_limit_reached` | Account has 5 active keypairs already |
| 429 | `rate_limited` | >5 key generations/hour |
| 500 | `key_generation_failed` | Crypto subsystem error |

---

### GET /api/v1/keys/:id/install-command

Returns the one-liner shell command to install the public key on a remote server.

| Field | Value |
|-------|-------|
| **Auth** | Required |
| **Rate limit** | None |
| **Idempotent** | Yes |

**Response (200):**

```json
{
  "command": "mkdir -p ~/.ssh && echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGn... clawdfather:default' >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys",
  "public_key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGn... clawdfather:default",
  "fingerprint": "SHA256:uNiRzE3rGluHDBGPmR0mVz07MiiWkOsaFXLRs9oag5Q"
}
```

**Errors:**

| Status | Code | When |
|--------|------|------|
| 401 | `unauthorized` | Missing or invalid token |
| 404 | `not_found` | Keypair ID doesn't exist or belongs to another account |

---

### DELETE /api/v1/keys/:id

Revoke a keypair. Marks it as revoked and deactivates it.

| Field | Value |
|-------|-------|
| **Auth** | Required |
| **Rate limit** | None |
| **Idempotent** | Yes (revoking already-revoked key returns 200) |

**Response (200):**

```json
{
  "keypair": {
    "id": "660e8400-e29b-41d4-a716-446655440001",
    "label": "default",
    "is_active": false,
    "revoked_at": "2026-02-21T15:30:00Z"
  }
}
```

**Side effects:**
- Sets `is_active = false`, `revoked_at = NOW()`
- Active sessions using this key are flagged for termination (within 60s via heartbeat check)
- Audit log: `key.revoke`

**Errors:**

| Status | Code | When |
|--------|------|------|
| 401 | `unauthorized` | Missing or invalid token |
| 404 | `not_found` | Keypair doesn't exist or belongs to another account |
| 409 | `active_sessions_exist` | Active sessions are using this key and `force` is not set |

---

## SSH Connection CRUD Endpoints

### GET /api/v1/connections

List all SSH connections for the authenticated account.

| Field | Value |
|-------|-------|
| **Auth** | Required |
| **Rate limit** | None |
| **Idempotent** | Yes |

**Response (200):**

```json
{
  "connections": [
    {
      "id": "770e8400-e29b-41d4-a716-446655440002",
      "label": "prod-api-1",
      "host": "192.168.1.100",
      "port": 22,
      "username": "deploy",
      "keypair_id": "660e8400-e29b-41d4-a716-446655440001",
      "host_key_fingerprint": "SHA256:abc123...",
      "last_tested_at": "2026-02-21T14:00:00Z",
      "last_test_result": "ok",
      "created_at": "2026-02-20T12:00:00Z"
    }
  ]
}
```

**Notes:**
- Only returns connections where `deleted_at IS NULL`.
- Sorted by `label` ascending.

---

### POST /api/v1/connections

Create a new saved SSH connection.

| Field | Value |
|-------|-------|
| **Auth** | Required |
| **Rate limit** | 20/hour per account |
| **Idempotent** | No |

**Request body:**

```json
{
  "label": "prod-api-1",
  "host": "192.168.1.100",
  "port": 22,
  "username": "deploy",
  "keypair_id": "660e8400-e29b-41d4-a716-446655440001"
}
```

- `port` defaults to `22` if omitted.
- `keypair_id` defaults to the account's active "default" keypair if omitted.

**Response (201):**

```json
{
  "connection": {
    "id": "770e8400-e29b-41d4-a716-446655440002",
    "label": "prod-api-1",
    "host": "192.168.1.100",
    "port": 22,
    "username": "deploy",
    "keypair_id": "660e8400-e29b-41d4-a716-446655440001",
    "created_at": "2026-02-21T15:30:00Z"
  }
}
```

**Validation:**
- `label`: required, 1-64 chars, unique per account (among non-deleted)
- `host`: required, valid hostname or IPv4/IPv6 address
- `port`: 1-65535
- `username`: required, 1-64 chars, valid Unix username characters
- `keypair_id`: must reference an active keypair owned by the account

**Side effects:**
- Audit log: `connection.create`

**Errors:**

| Status | Code | When |
|--------|------|------|
| 400 | `validation_error` | Invalid/missing fields |
| 401 | `unauthorized` | Missing or invalid token |
| 409 | `label_exists` | Connection with this label already exists for account |

---

### PATCH /api/v1/connections/:id

Update a saved SSH connection's fields.

| Field | Value |
|-------|-------|
| **Auth** | Required |
| **Rate limit** | None |
| **Idempotent** | Yes |

**Request body (all fields optional):**

```json
{
  "label": "prod-api-1-new",
  "host": "10.0.0.50",
  "port": 2222,
  "username": "admin",
  "keypair_id": "660e8400-e29b-41d4-a716-446655440099"
}
```

**Response (200):**

```json
{
  "connection": {
    "id": "770e8400-e29b-41d4-a716-446655440002",
    "label": "prod-api-1-new",
    "host": "10.0.0.50",
    "port": 2222,
    "username": "admin",
    "keypair_id": "660e8400-e29b-41d4-a716-446655440099",
    "host_key_fingerprint": null,
    "last_tested_at": null,
    "last_test_result": null,
    "updated_at": "2026-02-21T16:00:00Z"
  }
}
```

**Rules:**
- Changing `host` or `port` clears `host_key_fingerprint`, `last_tested_at`, and `last_test_result` (connection must be re-tested).
- Changing `host` is blocked if an active session exists on this connection (return 409).
- `updated_at` set to `NOW()` on every successful patch.

**Side effects:**
- Audit log: `connection.update`

**Errors:**

| Status | Code | When |
|--------|------|------|
| 400 | `validation_error` | Invalid fields |
| 401 | `unauthorized` | Missing or invalid token |
| 404 | `not_found` | Connection doesn't exist, is deleted, or belongs to another account |
| 409 | `active_session_exists` | Cannot change host while session is active |
| 409 | `label_exists` | New label conflicts with existing connection |

---

### DELETE /api/v1/connections/:id

Soft-delete a saved SSH connection.

| Field | Value |
|-------|-------|
| **Auth** | Required |
| **Rate limit** | None |
| **Idempotent** | Yes (deleting already-deleted connection returns 200) |

**Response (200):**

```json
{
  "connection": {
    "id": "770e8400-e29b-41d4-a716-446655440002",
    "deleted_at": "2026-02-21T16:30:00Z"
  }
}
```

**Side effects:**
- Sets `deleted_at = NOW()`
- Audit log: `connection.delete`

**Errors:**

| Status | Code | When |
|--------|------|------|
| 401 | `unauthorized` | Missing or invalid token |
| 404 | `not_found` | Connection doesn't exist or belongs to another account |
| 409 | `active_session_exists` | Cannot delete while session is active |

---

### POST /api/v1/connections/:id/test

Test SSH connectivity for a saved connection using the stored keypair.

| Field | Value |
|-------|-------|
| **Auth** | Required |
| **Rate limit** | 5/minute per connection |
| **Idempotent** | Yes (same result for same server state) |

**Request body:**

```json
{
  "accept_host_key": false
}
```

- `accept_host_key`: if `true`, accept and pin a changed host key (used after a 409 response).

**Response (200) — Success:**

```json
{
  "result": "ok",
  "latency_ms": 142,
  "host_key_fingerprint": "SHA256:abc123...",
  "message": "SSH connection successful."
}
```

**Response (200) — Failure:**

```json
{
  "result": "failed",
  "latency_ms": null,
  "message": "Authentication failed. The server rejected the public key. Ensure the install command was run."
}
```

**Response (200) — Timeout:**

```json
{
  "result": "timeout",
  "latency_ms": null,
  "message": "Connection timed out after 15 seconds. The server may be unreachable."
}
```

**Response (409) — Host key changed:**

```json
{
  "result": "host_key_changed",
  "old_fingerprint": "SHA256:abc123...",
  "new_fingerprint": "SHA256:def456...",
  "message": "The server's host key has changed. This could indicate a server reinstall or a potential security issue. Accept the new key to continue."
}
```

To accept the new key, re-send the test request with `{ "accept_host_key": true }`.

**Side effects:**
- Spawns short-lived SSH connection: `ssh -o ConnectTimeout=15 -o BatchMode=yes user@host echo ok`
- On success: pins host key fingerprint in `ssh_connections.host_key_fingerprint`, updates `last_tested_at` and `last_test_result`
- Audit log: `connection.test`

**Errors:**

| Status | Code | When |
|--------|------|------|
| 401 | `unauthorized` | Missing or invalid token |
| 404 | `not_found` | Connection doesn't exist or belongs to another account |
| 429 | `rate_limited` | >5 tests/minute for this connection |

---

## Session Lifecycle Endpoints

### POST /api/v1/sessions

Start a new agent session for a connection.

| Field | Value |
|-------|-------|
| **Auth** | Required |
| **Rate limit** | 10/hour per account |
| **Idempotent** | No |

**Request body:**

```json
{
  "connection_id": "770e8400-e29b-41d4-a716-446655440002"
}
```

**Response (201):**

```json
{
  "session": {
    "id": "880e8400-e29b-41d4-a716-446655440003",
    "status": "active",
    "agent_session_id": "oc_sess_abc123",
    "connection": {
      "id": "770e8400-e29b-41d4-a716-446655440002",
      "label": "prod-api-1",
      "host": "192.168.1.100",
      "username": "deploy"
    },
    "started_at": "2026-02-21T17:00:00Z",
    "chat_url": "wss://app.clawdfather.io/ws/sessions/880e8400-e29b-41d4-a716-446655440003"
  }
}
```

**Server-side flow:**

1. Validate connection exists, is tested (`last_test_result = 'ok'`), keypair is active
2. Check concurrent session limit (default 3 per account)
3. Create `session_leases` row with `status = 'pending'`
4. Decrypt private key from `agent_keypairs`
5. Write private key to temp file (`/tmp/clawdfather/<session_id>.key`, mode 0600)
6. Establish SSH ControlMaster: `ssh -N -o ControlMaster=yes -o ControlPath=/tmp/clawdfather/<session_id>.sock -i <key_file> user@host`
7. Delete temp key file after ControlMaster socket is established
8. Spawn OpenClaw agent session with connection metadata in context
9. Update session_lease: `status = 'active'`, `started_at = NOW()`, `agent_session_id = <id>`
10. Return session info

**Side effects:**
- Audit log: `session.start`

**Errors:**

| Status | Code | When |
|--------|------|------|
| 400 | `connection_not_tested` | Connection has never been successfully tested |
| 401 | `unauthorized` | Missing or invalid token |
| 404 | `not_found` | Connection doesn't exist or belongs to another account |
| 409 | `keypair_revoked` | The connection's keypair has been revoked |
| 409 | `session_limit_reached` | Account has 3 active sessions already |
| 429 | `rate_limited` | >10 session starts/hour |
| 502 | `ssh_connect_failed` | SSH ControlMaster failed to establish |
| 502 | `agent_spawn_failed` | OpenClaw agent session failed to start |

---

### GET /api/v1/sessions/:id

Get session status and metadata.

| Field | Value |
|-------|-------|
| **Auth** | Required |
| **Rate limit** | None |
| **Idempotent** | Yes |

**Response (200):**

```json
{
  "session": {
    "id": "880e8400-e29b-41d4-a716-446655440003",
    "status": "active",
    "agent_session_id": "oc_sess_abc123",
    "connection": {
      "id": "770e8400-e29b-41d4-a716-446655440002",
      "label": "prod-api-1",
      "host": "192.168.1.100",
      "port": 22,
      "username": "deploy"
    },
    "started_at": "2026-02-21T17:00:00Z",
    "last_heartbeat_at": "2026-02-21T17:25:00Z",
    "close_reason": null,
    "chat_url": "wss://app.clawdfather.io/ws/sessions/880e8400-e29b-41d4-a716-446655440003"
  }
}
```

**Errors:**

| Status | Code | When |
|--------|------|------|
| 401 | `unauthorized` | Missing or invalid token |
| 404 | `not_found` | Session doesn't exist or belongs to another account |

---

### DELETE /api/v1/sessions/:id

Close an active session gracefully.

| Field | Value |
|-------|-------|
| **Auth** | Required |
| **Rate limit** | None |
| **Idempotent** | Yes (closing already-closed session returns 200) |

**Response (200):**

```json
{
  "session": {
    "id": "880e8400-e29b-41d4-a716-446655440003",
    "status": "closed",
    "closed_at": "2026-02-21T17:30:00Z",
    "close_reason": "user"
  }
}
```

**Server-side flow:**

1. Send `ssh -O exit` to ControlMaster socket
2. Unlink socket file
3. Terminate OpenClaw agent session
4. Close all WebSocket connections for this session
5. Update session_lease: `status = 'closed'`, `closed_at = NOW()`, `close_reason = 'user'`

**Side effects:**
- Audit log: `session.close`

**Errors:**

| Status | Code | When |
|--------|------|------|
| 401 | `unauthorized` | Missing or invalid token |
| 404 | `not_found` | Session doesn't exist or belongs to another account |

---

### GET /api/v1/sessions

List sessions for the authenticated account (paginated).

| Field | Value |
|-------|-------|
| **Auth** | Required |
| **Rate limit** | None |
| **Idempotent** | Yes |

**Query parameters:**
- `status` — filter by status: `active`, `closed`, `error`, `pending` (optional)
- `limit` — max results (default 20, max 100)
- `offset` — pagination offset (default 0)

**Response (200):**

```json
{
  "sessions": [
    {
      "id": "880e8400-e29b-41d4-a716-446655440003",
      "status": "active",
      "connection": {
        "id": "770e8400-e29b-41d4-a716-446655440002",
        "label": "prod-api-1",
        "host": "192.168.1.100"
      },
      "started_at": "2026-02-21T17:00:00Z",
      "last_heartbeat_at": "2026-02-21T17:25:00Z"
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

**Notes:**
- Sorted by `created_at DESC` (most recent first).
- Closed/error sessions included for history view (filter with `?status=active` for active only).

---

## Audit Log Endpoint

### GET /api/v1/audit

Paginated audit log for the authenticated account.

| Field | Value |
|-------|-------|
| **Auth** | Required |
| **Rate limit** | None |
| **Idempotent** | Yes |

**Query parameters:**
- `limit` — max results (default 50, max 100)
- `before` — ISO 8601 timestamp cursor for backward pagination (returns entries created before this timestamp)
- `action` — filter by action type (e.g., `session.start`, `connection.test`)

**Response (200):**

```json
{
  "entries": [
    {
      "id": 42,
      "action": "session.start",
      "target_type": "session_lease",
      "target_id": "880e8400-e29b-41d4-a716-446655440003",
      "result": "ok",
      "ip_address": "203.0.113.42",
      "detail": {
        "connection_label": "prod-api-1",
        "host": "192.168.1.100"
      },
      "created_at": "2026-02-21T17:00:00Z"
    },
    {
      "id": 41,
      "action": "connection.test",
      "target_type": "ssh_connection",
      "target_id": "770e8400-e29b-41d4-a716-446655440002",
      "result": "ok",
      "ip_address": "203.0.113.42",
      "detail": {
        "latency_ms": 142
      },
      "created_at": "2026-02-21T16:55:00Z"
    }
  ],
  "has_more": true,
  "next_before": "2026-02-21T16:55:00Z"
}
```

**Notes:**
- Uses cursor-based pagination (`before` timestamp) rather than offset for consistency with append-only data.
- `has_more` indicates whether more entries exist before the oldest returned entry.
- `next_before` is the `created_at` of the last entry in the response — use as the `before` param for the next page.

**Errors:**

| Status | Code | When |
|--------|------|------|
| 401 | `unauthorized` | Missing or invalid token |

---

## Health Endpoint

### GET /health

System health check. No authentication required.

| Field | Value |
|-------|-------|
| **Auth** | None |
| **Rate limit** | None |
| **Idempotent** | Yes |

**Response (200):**

```json
{
  "status": "ok",
  "active_sessions": 3,
  "db": "ok",
  "version": "0.2.0",
  "uptime_s": 86400
}
```

**Response (503) — unhealthy:**

```json
{
  "status": "degraded",
  "active_sessions": 0,
  "db": "unreachable",
  "version": "0.2.0",
  "uptime_s": 86400
}
```

---

## Error Response Format

All error responses follow this structure:

```json
{
  "error": {
    "code": "machine_readable_error_code",
    "message": "Human-readable explanation of what went wrong.",
    "detail": {}
  }
}
```

### Standard Error Codes

| HTTP Status | Code | Description |
|-------------|------|-------------|
| 400 | `validation_error` | Request body failed validation |
| 401 | `unauthorized` | Missing, expired, or revoked auth token |
| 403 | `forbidden` | Authenticated but not authorized for this resource |
| 404 | `not_found` | Resource does not exist or is not accessible |
| 409 | `conflict` | Operation conflicts with current state (details in code) |
| 429 | `rate_limited` | Too many requests — `Retry-After` header included |
| 500 | `internal_error` | Unexpected server error |
| 502 | `upstream_error` | Upstream service (GitHub, SSH) failed |

### Rate Limit Headers

All rate-limited endpoints include these response headers:

```
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 7
X-RateLimit-Reset: 1708534200
Retry-After: 45
```

`Retry-After` is only included on 429 responses.

---

## WebSocket Protocol

### Connection

```
wss://app.clawdfather.io/ws/sessions/:session_id
```

**Headers:**
```
Authorization: Bearer clf_a1b2c3d4e5f6...
```

### Client → Server Messages

**Authenticate (first message):**
```json
{ "type": "auth", "token": "clf_a1b2c3d4e5f6..." }
```

**Send chat message:**
```json
{ "type": "message", "text": "List all running Docker containers" }
```

**Heartbeat (every 30s):**
```json
{ "type": "heartbeat" }
```

### Server → Client Messages

**Auth success:**
```json
{
  "type": "session",
  "session_id": "880e8400...",
  "connection": { "label": "prod-api-1", "host": "192.168.1.100", "username": "deploy" }
}
```

**Assistant message:**
```json
{
  "type": "message",
  "role": "assistant",
  "text": "Here are the running containers:\n..."
}
```

**Status update:**
```json
{ "type": "status", "status": "thinking" }
```
```json
{ "type": "status", "status": "done" }
```

**Heartbeat acknowledgment:**
```json
{ "type": "heartbeat_ack", "server_time": "2026-02-21T17:25:00Z" }
```

**Error:**
```json
{ "type": "error", "message": "Session expired or invalidated" }
```

**Session ended (server-initiated):**
```json
{ "type": "session_closed", "reason": "timeout", "message": "Session expired due to inactivity." }
```
