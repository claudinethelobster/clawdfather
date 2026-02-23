# Phased Implementation Plan

> Clawdfather — Mobile-First Account-Based SSH Orchestration

---

## Phase 0 — Foundation (Weeks 1–2)

**Goal:** Infrastructure and auth. No SSH yet.

### Deliverables

| # | Task | Details |
|---|------|---------|
| 0.1 | **Database setup + schema migration** | PostgreSQL provisioning (local dev: Docker Compose, staging: managed PG). Migration tool: [node-pg-migrate](https://github.com/salsita/node-pg-migrate) or Drizzle Kit. Create all 6 tables: `accounts`, `oauth_identities`, `agent_keypairs`, `ssh_connections`, `session_leases`, `app_sessions`, `audit_log`. All indexes from Data Model doc. Run `CREATE EXTENSION IF NOT EXISTS "pgcrypto"` for `gen_random_uuid()` |
| 0.2 | **GitHub OAuth flow** | `POST /api/v1/auth/oauth/github/start` — generate state, PKCE challenge, return authorize_url. `GET /api/v1/auth/oauth/github/callback` — validate state cookie, exchange code for GitHub access token, fetch user info (`GET /user` + `GET /user/emails`), create or link `accounts` + `oauth_identities`, issue app session token. Register GitHub OAuth App (dev + staging). Environment variables: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `OAUTH_CALLBACK_URL` |
| 0.3 | **App session token issuance + validation middleware** | Token generation: `clf_` prefix + 32 bytes CSPRNG (base64url). Storage: SHA-256 hash in `app_sessions.token_hash`. Middleware: extract `Authorization: Bearer <token>`, hash, lookup in DB, check `expires_at` and `revoked_at`, inject `account_id` into request context. Sliding expiry: update `last_used_at` and extend `expires_at` on each valid request (debounced to once per 5 min). `DELETE /api/v1/auth/session` for logout |
| 0.4 | **GET /api/v1/auth/me** | Return current account info (id, display_name, email, oauth_providers). Simple endpoint to verify auth pipeline works end-to-end |
| 0.5 | **Audit log infrastructure** | `audit()` helper function that inserts into `audit_log` table. Called from all auth endpoints. Structured JSON logging to stdout via pino or similar |
| 0.6 | **Unit tests** | Auth flow tests (mock GitHub API). Token hashing + validation tests. Middleware tests (valid/expired/revoked tokens). Audit log insertion tests |

### Acceptance Criteria

- [ ] `POST /api/v1/auth/oauth/github/start` returns valid GitHub authorize URL with state + PKCE
- [ ] GitHub OAuth callback creates account, returns `{ token, account, expires_at }`
- [ ] `GET /api/v1/auth/me` with valid token returns account info
- [ ] `GET /api/v1/auth/me` with expired/revoked/invalid token returns 401
- [ ] `DELETE /api/v1/auth/session` revokes token, subsequent requests return 401
- [ ] All auth events appear in `audit_log` table
- [ ] All unit tests pass
- [ ] Database migrations run cleanly (up and down)

### Dependencies

- PostgreSQL instance (Docker Compose for dev)
- GitHub OAuth App registered
- Environment variables configured

---

## Phase 1 — Key Provisioning + Connection Management (Weeks 3–5)

**Goal:** Users can add, test, and manage SSH connections.

### Deliverables

| # | Task | Details |
|---|------|---------|
| 1.1 | **Ed25519 keypair generation** | `crypto.generateKeyPair('ed25519')` with PEM output. Convert public key to OpenSSH format for `authorized_keys`. Encrypt private key with AES-256-GCM using per-account KEK (HKDF from master key + account_id). Store in `agent_keypairs`. Environment variable: `CLAWDFATHER_MASTER_KEY` (32 bytes hex) |
| 1.2 | **Key API endpoints** | `GET /api/v1/keys` — list keypairs. `POST /api/v1/keys` — generate new keypair (idempotent on label). `GET /api/v1/keys/:id/install-command` — return `echo '<pubkey>' >> ~/.ssh/authorized_keys` one-liner. `DELETE /api/v1/keys/:id` — revoke keypair |
| 1.3 | **SSH connection CRUD** | `POST /api/v1/connections` — create connection. `GET /api/v1/connections` — list connections. `PATCH /api/v1/connections/:id` — update (clears host key on host/port change). `DELETE /api/v1/connections/:id` — soft delete |
| 1.4 | **Connection test endpoint** | `POST /api/v1/connections/:id/test` — decrypt private key, write to temp file, spawn `ssh -o BatchMode=yes -o ConnectTimeout=15 user@host echo ok`, capture result, delete temp file. Host key handling: extract fingerprint, compare with stored, return 409 on mismatch. Rate limited: 5/min per connection |
| 1.5 | **Host key TOFU + pinning** | First test: store host key fingerprint in `ssh_connections.host_key_fingerprint`. Subsequent tests: verify fingerprint matches. Mismatch: return 409 with old + new fingerprints. Accept: `{ "accept_host_key": true }` re-pins |
| 1.6 | **Audit logging for keys + connections** | Log: `key.generate`, `key.revoke`, `connection.create`, `connection.update`, `connection.test`, `connection.delete` |
| 1.7 | **Basic mobile UI** | Login screen with "Sign in with GitHub" button. Connections list (empty state + populated). "Add Connection" bottom sheet form. "Install Key" screen with copy/share. "Test Connection" with spinner + result. Connection detail view. Navigation: bottom tab bar (Connections, Settings) |

### Acceptance Criteria

- [ ] `POST /api/v1/keys` generates Ed25519 keypair, returns public key + fingerprint
- [ ] Private key is encrypted in DB (verify ciphertext format: `<nonce>:<ct>:<tag>`)
- [ ] `GET /api/v1/keys/:id/install-command` returns valid shell one-liner
- [ ] Running install command on test server + `POST /connections/:id/test` returns `{ "result": "ok" }`
- [ ] Host key fingerprint pinned after first successful test
- [ ] Second test with same server succeeds without TOFU prompt
- [ ] Changing host key on server → test returns 409 with both fingerprints
- [ ] Sending `{ "accept_host_key": true }` → re-pins and succeeds
- [ ] Connection soft delete works (sets `deleted_at`, disappears from list)
- [ ] Mobile UI: can log in, add connection, test connection, see success
- [ ] All key/connection events in audit log

### Dependencies

- Phase 0 complete (auth, DB, middleware)
- Test SSH server available (can use Docker: `docker run -d -p 2222:22 lscr.io/linuxserver/openssh-server`)
- `CLAWDFATHER_MASTER_KEY` environment variable set

---

## Phase 2 — Session Lifecycle (Weeks 6–8)

**Goal:** Full end-to-end agent sessions from mobile.

### Deliverables

| # | Task | Details |
|---|------|---------|
| 2.1 | **Session start endpoint** | `POST /api/v1/sessions` — validate connection (tested, key active). Create `session_leases` row (pending). Decrypt private key → temp file (0600). Spawn ControlMaster (ssh -N -o ControlMaster=yes ...). Wait for socket. Delete temp key. Spawn OpenClaw agent session with connection context. Update session_lease → active. Return session ID + chat_url |
| 2.2 | **Session heartbeat** | WebSocket heartbeat: client sends `{ "type": "heartbeat" }` every 30s. Server updates `session_leases.last_heartbeat_at`. Returns `{ "type": "heartbeat_ack" }`. API calls also count as heartbeat |
| 2.3 | **Orphan cleanup job** | `setInterval` every 60s. Scan `session_leases WHERE status = 'active' AND last_heartbeat_at < NOW() - INTERVAL '2 minutes'`. For each: send `ssh -O exit`, unlink socket, update DB, close WebSocket clients, audit log |
| 2.4 | **Session close endpoint** | `DELETE /api/v1/sessions/:id` — send `ssh -O exit` to ControlMaster, kill agent session, close WebSocket clients, update session_lease (closed, close_reason=user) |
| 2.5 | **WebSocket re-attach** | Reconnect flow: client connects to `wss://host/ws/sessions/:id`, sends auth, server validates session is still active, re-registers WebSocket client. If session expired, returns error |
| 2.6 | **Concurrent session limit** | Check `SELECT count(*) FROM session_leases WHERE account_id = $1 AND status IN ('pending', 'active')` before creating new session. Default limit: 3. Return 409 if exceeded |
| 2.7 | **Mobile UI: session view** | Full-screen chat interface. Header: connection label, host, session timer. Message input (bottom, large touch target). "End Session" button. Reconnect flow: spinner + auto-retry on app foreground. Session list in Sessions tab |
| 2.8 | **Observability** | Prometheus metrics endpoint (`GET /metrics`). Active sessions gauge, start/close/error counters, SSH connect latency histogram. Health endpoint (`GET /health`). Structured JSON logging for all SSH events |

### Acceptance Criteria

- [ ] Tap "Start Session" on tested connection → agent session starts, chat works
- [ ] AI agent can execute commands on remote server via SSH (through ControlMaster)
- [ ] WebSocket heartbeat keeps session alive
- [ ] Close app for >30 min → session cleaned up (ControlMaster gone, lease closed)
- [ ] Close app for <5 min → reopen → session reconnects automatically
- [ ] `DELETE /sessions/:id` → ControlMaster torn down, WebSocket closed
- [ ] 4th concurrent session attempt returns 409
- [ ] `GET /metrics` returns Prometheus-format metrics
- [ ] `GET /health` returns system status
- [ ] Orphan cleanup job catches sessions with stale heartbeats
- [ ] All session events in audit log

### Dependencies

- Phase 1 complete (keys, connections)
- OpenClaw runtime API for spawning agent sessions
- WebSocket infrastructure from existing `web-server.ts` (extended)

---

## Phase 3 — Hardening + Migration (Weeks 9–11)

**Goal:** Production-ready. Migrate existing SSH-first users.

### Deliverables

| # | Task | Details |
|---|------|---------|
| 3.1 | **Push notifications** | Firebase Cloud Messaging (FCM) / APNs integration. Events: session about to expire (5 min warning), session ended, security alert (new login). User opt-in in Settings. Token stored in new `push_tokens` table |
| 3.2 | **Key rotation workflow** | UI: "Rotate Key" button in Settings → Keys. Server: generate new key → for each connection, SSH in with old key, install new key, test, remove old key. Progress UI. Handle partial failures (some servers unreachable). Old key → rotated state → 7-day grace → revoked |
| 3.3 | **Rate limiting middleware** | Token bucket or sliding window per IP and per account. Configurable limits per endpoint. Redis-backed for distributed deployment (or in-memory for single-server). Rate limit headers on all responses (`X-RateLimit-*`). 429 responses with `Retry-After` |
| 3.4 | **Brute-force mitigations** | Failed auth tracking per IP and per account. Temporary IP block after threshold. Temporary account lock after threshold. Notification to account owner. Admin unlock capability |
| 3.5 | **E2E test suite** | Playwright tests against real API + DB. Full flow: login → add connection → install key on test server → test connection → start session → send message → close session. Run against Docker Compose test environment |
| 3.6 | **Migration: SSH-first deprecation** | Add banner to SSH welcome screen (existing `ssh-server.ts`): "Clawdfather now supports mobile login. Visit clawdfather.io/setup to migrate." SSH-first flow continues working but marked as deprecated. Documentation: migration guide for existing users |
| 3.7 | **Security audit** | OWASP ZAP scan against all API endpoints. Fix any findings. Review: auth headers, CSRF, injection, XSS. Penetration test on key decryption flow. Verify no secrets in logs |

### Acceptance Criteria

- [ ] Push notification received when session expires
- [ ] Key rotation works end-to-end: new key generated, installed on servers, old key revoked after grace period
- [ ] Rate limits enforced on all endpoints (verify with load test)
- [ ] Account locks after repeated failed auth attempts
- [ ] E2E test suite passes: full login → session → close flow
- [ ] SSH-first login shows deprecation banner with migration link
- [ ] OWASP ZAP scan clean (no high/critical findings)
- [ ] Migration guide documented and tested

### Dependencies

- Phases 0–2 complete
- Firebase project configured (for push notifications)
- Redis instance (if distributed rate limiting needed)
- Test SSH server (Docker) for E2E tests

---

## Migration Strategy from SSH-First Flow

### Timeline

```
Phase 0–2 (Weeks 1–8):
  └── SSH-first flow continues working unchanged
      └── Users SSH in, get prompted for target, session created
      └── No disruption to existing workflow

Phase 3 (Weeks 9–11):
  └── SSH welcome banner updated:
      "╔══════════════════════════════════════════╗
       ║  🆕 Mobile login now available!          ║
       ║  Visit clawdfather.io/setup to migrate  ║
       ║  SSH login will be deprecated soon.      ║
       ╚══════════════════════════════════════════╝"
  └── SSH-first flow still works but deprecated
  └── New users directed to OAuth flow only

Post-Phase 3 (Week 12+):
  └── SSH-first flow disabled for new connections
  └── Existing SSH sessions grandfathered for 30 days
  └── After 30 days: SSH server removed entirely
```

### Migration Steps for Existing Users

1. **User receives deprecation banner** when SSHing in (Phase 3)
2. **User visits setup page** → directed to mobile app or web UI
3. **User signs in with GitHub** → account created (or linked if email matches)
4. **System generates keypair** → user gets public key
5. **User adds their existing server as a connection** → enters host/user/port
6. **User runs install command** → adds Clawdfather public key to server
7. **User tests connection** → verifies new auth flow works
8. **Done** — user can now start sessions from mobile without SSH client

### Data Migration

- **Existing sessions are ephemeral** — no migration needed. They're in-memory and session-scoped.
- **No user data to migrate** — the SSH-first flow has no accounts or persistent data.
- **Host keys:** Users will go through TOFU again for each connection in the new flow. This is intentional — ensures host key pinning is tied to the new system.

### Rollback Plan

If migration causes issues:
1. SSH-first flow is not removed until 30 days after Phase 3 launch
2. Both flows work simultaneously during transition
3. If critical issues found, deprecation banner can be removed in one commit
4. Rollback: revert SSH server changes, keep OAuth system running in parallel

---

## Testing Plan

### Test Levels

| Level | Tool | Scope | Coverage Target |
|-------|------|-------|----------------|
| **Unit** | Vitest | Auth token hashing, CSRF validation, keypair generation, AES-256-GCM encrypt/decrypt, HKDF KEK derivation, state machine transitions (session_lease status), input validation | >90% of crypto and auth modules |
| **Integration** | Supertest + real DB | All API endpoints with real PostgreSQL (test schema). Request validation, auth middleware, DB operations, error responses. Docker Compose: Postgres + test SSH server | 100% of API endpoints |
| **E2E** | Playwright | Full mobile flow in browser: GitHub OAuth (mocked provider) → add connection → install key on test server → test connection → start session → chat → close session → reconnect | Critical path (happy path + key error paths) |
| **Manual** | Test devices | iOS Safari + Android Chrome on real devices. Real GitHub OAuth. Real SSH server on LAN. Test: biometric, background/foreground, push notifications, slow network | iOS 16+ and Android 12+ |
| **Security** | OWASP ZAP | Automated scan: auth endpoints, injection (SQL, command), XSS, CSRF, security headers, cookie flags. Manual review: key encryption, token hashing, temp file handling | All public endpoints |
| **Load** | k6 | Concurrent session starts (target: 50 simultaneous sessions). Connection test throughput. API response time under load. WebSocket message throughput | p99 < 5s for session start, p99 < 500ms for API calls |

### Test Environment Architecture

```
┌──────────────────────────────────────────────────┐
│              Docker Compose (test)                │
│                                                    │
│  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│  │ Postgres  │  │ Redis    │  │ SSH Test Server │  │
│  │ :5432     │  │ :6379    │  │ :2222           │  │
│  │ (test DB) │  │ (rate    │  │ (openssh-server │  │
│  │           │  │  limits) │  │  Docker image)  │  │
│  └──────────┘  └──────────┘  └────────────────┘  │
│                                                    │
│  ┌──────────────────────────────────────────────┐ │
│  │ Clawdfather API Server                       │ │
│  │ :3000 (HTTP/WS)                              │ │
│  │ CLAWDFATHER_MASTER_KEY=test_key_hex          │ │
│  │ GITHUB_CLIENT_ID=test                        │ │
│  │ DATABASE_URL=postgres://test@postgres/test   │ │
│  └──────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

### CI Pipeline

```
PR opened/updated:
  1. Lint (eslint + prettier)
  2. Type check (tsc --noEmit)
  3. Unit tests (vitest)
  4. Integration tests (Docker Compose up → supertest → down)
  5. E2E tests (Docker Compose up → Playwright → down)
  6. Security scan (OWASP ZAP baseline scan)

Merge to main:
  7. All of above +
  8. Build production image
  9. Deploy to staging
  10. Smoke tests against staging
```
