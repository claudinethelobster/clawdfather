# PR-Ready Engineering Breakdown

> Clawdfather — Mobile-First Account-Based SSH Orchestration

---

## Epic Map

### Epic 1: Auth & Account System

**Phase:** 0  |  **Estimate:** ~12 points  |  **Duration:** ~1 week

| Issue | Title | Points | Description |
|-------|-------|--------|-------------|
| #1 | DB schema migrations | 3 | Create all tables: `accounts`, `oauth_identities`, `app_sessions`, `agent_keypairs`, `ssh_connections`, `session_leases`, `audit_log`. All indexes. Migration tool setup (node-pg-migrate or Drizzle Kit). Up + down migrations. Docker Compose for local Postgres. |
| #2 | GitHub OAuth flow (start + callback) | 5 | `POST /api/v1/auth/oauth/github/start` — state generation, PKCE, cookie, redirect URL. `GET /api/v1/auth/oauth/github/callback` — state validation, code exchange, GitHub user fetch, account create/link, `oauth_identities` insert. GitHub OAuth App registration. Env vars: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `OAUTH_CALLBACK_URL`. |
| #3 | Session token middleware | 3 | Token generation (`clf_` + 32 bytes CSPRNG). SHA-256 hashing. Express/Hono middleware: extract Bearer token, hash, DB lookup, check expiry/revocation, inject account context. Sliding expiry (debounced). `DELETE /api/v1/auth/session` for logout. |
| #4 | /api/v1/auth/me endpoint + tests | 1 | Return account info. Unit tests for all of Epic 1: mock GitHub API, token roundtrip, middleware rejection cases, audit log entries. |

**Depends on:** Database available (Docker Compose)

**PR structure:**
- PR 1: DB migrations (#1)
- PR 2: OAuth + token middleware (#2, #3, #4) — these are tightly coupled, ship together

---

### Epic 2: Key Provisioning

**Phase:** 1  |  **Estimate:** ~12 points  |  **Duration:** ~1 week

| Issue | Title | Points | Description |
|-------|-------|--------|-------------|
| #5 | Keypair generation + AES-256-GCM encryption at rest | 5 | `crypto.generateKeyPair('ed25519')`. PEM → OpenSSH format conversion. HKDF KEK derivation (`master_key + account_id → per-account KEK`). AES-256-GCM encryption (12-byte nonce, ciphertext, 16-byte auth tag). Storage format: `<b64 nonce>:<b64 ct>:<b64 tag>`. Decryption function. Env var: `CLAWDFATHER_MASTER_KEY`. Unit tests for roundtrip encrypt/decrypt, different accounts produce different KEKs. |
| #6 | GET /api/v1/keys + POST /api/v1/keys | 3 | List endpoint (returns all keypairs for account, private key excluded). Generate endpoint (idempotent on label — if active key with same label exists, return it). Limit: max 5 active keys per account. Integration tests. |
| #7 | GET /api/v1/keys/:id/install-command | 2 | Return `mkdir -p ~/.ssh && echo '<pubkey>' >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`. Include raw public key + fingerprint in response. Test: verify command is valid bash. |
| #8 | DELETE /api/v1/keys/:id | 2 | Set `is_active = false`, `revoked_at = NOW()`. Check for active sessions using this key (query `session_leases`). If active sessions exist, return 409 with message. Audit log: `key.revoke`. |

**Depends on:** Epic 1 (auth middleware, accounts table)

**PR structure:**
- PR 3: Crypto module — keypair generation + encryption (#5)
- PR 4: Key API endpoints (#6, #7, #8)

---

### Epic 3: SSH Connection Management

**Phase:** 1  |  **Estimate:** ~18 points  |  **Duration:** ~1.5 weeks

| Issue | Title | Points | Description |
|-------|-------|--------|-------------|
| #9 | Connection CRUD endpoints + validation | 5 | `POST /api/v1/connections` — create with validation (label unique per account, valid host/port/username, keypair exists and active). `GET /api/v1/connections` — list (WHERE deleted_at IS NULL). `PATCH /api/v1/connections/:id` — update (clear host_key_fingerprint on host/port change, block host change if active session). Validation module: hostname regex, port range, username chars. Integration tests for all CRUD operations. |
| #10 | Connection test (real SSH + host key TOFU/pin) | 8 | `POST /api/v1/connections/:id/test`. Decrypt keypair private key. Write to temp file (mode 0600). Spawn: `ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes -o UserKnownHostsFile=<temp> -i <key> user@host echo ok`. Parse result: success (exit 0), auth failure (exit 255 + "Permission denied"), timeout, connection refused. Extract host key fingerprint from `ssh-keyscan`. On first test: store fingerprint (TOFU). On subsequent: compare. Delete temp files. Rate limit: 5/min per connection. Integration test with Docker SSH server. |
| #11 | Host key mismatch flow (409 + re-pin) | 3 | When test detects host key change (stored fingerprint != server fingerprint): return 409 with `{ old_fingerprint, new_fingerprint }`. When `{ "accept_host_key": true }` sent: update `host_key_fingerprint` to new value, log `connection.host_key_changed` in audit log with both fingerprints. Test: change host key on Docker server, verify 409, verify re-pin. |
| #12 | Soft delete + cascade checks | 2 | `DELETE /api/v1/connections/:id` — set `deleted_at = NOW()`. Check: if active `session_leases` exist for this connection, return 409. Deleted connections excluded from all list queries. Audit log: `connection.delete`. Test: verify cascade check prevents delete with active session. |

**Depends on:** Epic 2 (keypair decryption for connection test)

**PR structure:**
- PR 5: Connection CRUD (#9)
- PR 6: Connection test + host key (#10, #11)
- PR 7: Soft delete (#12)

---

### Epic 4: Session Lifecycle

**Phase:** 2  |  **Estimate:** ~26 points  |  **Duration:** ~2 weeks

| Issue | Title | Points | Description |
|-------|-------|--------|-------------|
| #13 | Session start (spawn agent + ControlMaster) | 13 | `POST /api/v1/sessions` — the critical path. Validate: connection tested, keypair active, session limit not hit. Create session_lease (pending). Decrypt private key → temp file (0600). Write temp known_hosts with pinned host key. Spawn ControlMaster: `ssh -N -o ControlMaster=yes -o ControlPath=/tmp/clawdfather/<sid>.sock -o UserKnownHostsFile=<temp> -i <temp_key> -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ConnectTimeout=10 user@host`. Wait for socket file (poll every 100ms, timeout 10s). Delete temp key + known_hosts. Spawn OpenClaw agent session with context payload. Update session_lease (active). Return session info + chat_url. Error handling: if SSH fails → session_lease to error state, cleanup temps. If agent fails → close ControlMaster, session_lease to error. |
| #14 | Session heartbeat + cleanup job | 5 | WebSocket handler: on `{ "type": "heartbeat" }` → update `session_leases.last_heartbeat_at`, respond `{ "type": "heartbeat_ack" }`. Cleanup job: `setInterval(60s)` → query stale sessions (last_heartbeat > 2 min) → for each: `ssh -O exit`, unlink socket, update DB (closed/timeout), close WebSocket clients, audit log. |
| #15 | Session close endpoint | 3 | `DELETE /api/v1/sessions/:id` — send `ssh -S <sock> -O exit user@host`. Unlink socket. Terminate OpenClaw agent session. Close WebSocket clients. Update session_lease: status=closed, closed_at=NOW(), close_reason=user. Idempotent: closing already-closed session returns 200. Audit log: `session.close`. |
| #16 | WebSocket re-attach for reconnect | 5 | Extend existing WebSocket handler. On new connection: client sends `{ "type": "auth", "token": "clf_..." }`. Server validates token (hash + DB lookup), then validates session_lease is active. If valid: register WebSocket for session, send session info. If expired: send error, close. Client-side: exponential backoff reconnect (1s, 2s, 4s, 8s, 16s, cap 30s). GET /api/v1/sessions?status=active for session discovery on app foreground. |

**Depends on:** Epic 3 (tested connections with pinned host keys)

**PR structure:**
- PR 8: Session start — the big one (#13)
- PR 9: Heartbeat + cleanup (#14)
- PR 10: Session close + reconnect (#15, #16)

---

### Epic 5: Mobile UI

**Phase:** 1–2 (parallel with backend)  |  **Estimate:** ~26 points  |  **Duration:** ~3 weeks

| Issue | Title | Points | Description |
|-------|-------|--------|-------------|
| #17 | Auth screen (GitHub OAuth web view) | 5 | Login screen: Clawdfather logo, "Sign in with GitHub" button. Tap → open system browser (ASWebAuthenticationSession on iOS, Chrome Custom Tab on Android) to OAuth start URL. Handle callback: receive token, store in Keychain/Keystore. Navigate to home screen. Token refresh handling. Biometric lock setup prompt after first login. |
| #18 | Connections list + add connection form | 5 | Home screen: connection cards (label, host, status indicator). Empty state: "Add your first server" CTA. FAB or nav button → bottom sheet form (label, host, port, username). Validation (inline errors). Submit → API call → navigate to install key step. Pull-to-refresh on list. |
| #19 | Test connection UI + TOFU confirmation | 5 | "Install Key" step: copy button, share sheet, QR code for install command. "Test Connection" button: spinner, success/failure animation. TOFU dialog: show fingerprint, "Trust this server?" with Accept/Reject. Host key mismatch: warning dialog with old/new fingerprints. Connection card status updates after test. |
| #20 | Session view + chat integration | 8 | Full-screen chat interface. Header: connection label, host, session duration timer. Message list (scrollable, auto-scroll to bottom). Input bar (text field + send button, min 44px touch target). Agent message rendering (markdown support for code blocks). Status indicators: "thinking..." spinner. "End Session" button in header. |
| #21 | Reconnect flow UI | 3 | App foreground → check active sessions → if found, show "Reconnecting..." overlay. Success: resume chat. Failure: "Session expired" card with "Start New Session" button. Network loss during session: "Connection lost. Reconnecting..." banner at top. Auto-retry with progress indicator. |

**Depends on:** Epics 1–4 for real API calls (can develop against mocked API first)

**PR structure:**
- PR 11: Auth screen (#17)
- PR 12: Connections UI (#18, #19) — tightly coupled
- PR 13: Session UI (#20, #21)

---

### Epic 6: Security & Hardening

**Phase:** 3  |  **Estimate:** ~21 points  |  **Duration:** ~1.5 weeks

| Issue | Title | Points | Description |
|-------|-------|--------|-------------|
| #22 | Rate limiting middleware | 3 | Token bucket or sliding window implementation. Redis-backed for distributed (in-memory fallback for single-server). Per-endpoint configuration (from API Surface doc). Rate limit response headers (`X-RateLimit-*`). 429 responses with `Retry-After`. Integration tests: verify limits enforced. |
| #23 | Brute-force mitigation + account lock | 5 | Track failed auth per IP (Redis counter with TTL). Track failed auth per account. IP block threshold: >20 failed OAuth callbacks/hour → block IP 1 hour. Account lock threshold: >10 failed token validations/10 min → lock account 15 min. Account lock UI: "Your account is temporarily locked. Try again in N minutes." Admin unlock endpoint (internal). Email notification to account on lock. |
| #24 | Key rotation workflow | 5 | `POST /api/v1/keys/:id/rotate` — generate new key with same label. For each connection using old key: SSH in with old key, append new pubkey to authorized_keys, test with new key, remove old pubkey. Update connection's keypair_id to new key. Mark old key as rotated (is_active=false, rotated_at=NOW()). Background job: after 7 days, mark rotated keys as revoked. Handle partial failure: track progress per connection, allow retry for failed servers. |
| #25 | Audit log hardening + retention policy | 3 | Verify audit log captures all events (cross-reference with Security Model doc). Implement retention: background job deletes entries older than 90 days (or archives to S3 first). Monthly partition creation job. Verify no sensitive data in log detail field (no keys, tokens, passwords). |
| #26 | OWASP ZAP scan + fixes | 5 | Run OWASP ZAP baseline scan against all endpoints. Fix findings: security headers (HSTS, X-Content-Type-Options, X-Frame-Options, CSP), cookie flags (HttpOnly, Secure, SameSite), input sanitization, error information leakage. Re-scan to verify fixes. Document remaining low-risk accepted findings. |

**Depends on:** Epics 1–5 (full system running)

**PR structure:**
- PR 14: Rate limiting (#22)
- PR 15: Brute-force + account lock (#23)
- PR 16: Key rotation (#24)
- PR 17: Audit hardening + security scan (#25, #26)

---

### Epic 7: Migration & Deprecation

**Phase:** 3  |  **Estimate:** ~13 points  |  **Duration:** ~1 week

| Issue | Title | Points | Description |
|-------|-------|--------|-------------|
| #27 | SSH-first deprecation banner | 2 | Update `ssh-server.ts` BANNER constant to include migration notice. Shown after ASCII art, before prompt. Text: "Mobile login now available! Visit clawdfather.io/setup to migrate. SSH login will be deprecated soon." Feature flag: `DEPRECATION_BANNER_ENABLED=true` env var. |
| #28 | Migration docs + runbook | 3 | User-facing guide: "Migrating from SSH to Mobile Login". Step-by-step with screenshots. FAQ: "Will I lose access?", "Do I need to change my server config?", "Can I keep using SSH temporarily?". Operator runbook: how to enable/disable deprecation banner, how to force-migrate, how to rollback. |
| #29 | E2E test suite | 8 | Playwright tests covering critical paths: (1) OAuth login (mocked GitHub provider). (2) Add connection + install key on test server. (3) Test connection (success + failure). (4) Start session + send chat message + receive response. (5) Close session. (6) Reconnect to active session. (7) Session timeout cleanup. Docker Compose test environment with Postgres + SSH server + app. CI integration: run on every PR merge to main. |

**Depends on:** Epics 1–6 (everything else done)

**PR structure:**
- PR 18: Deprecation banner (#27)
- PR 19: Migration docs (#28)
- PR 20: E2E test suite (#29)

---

## Dependency Map

```
Epic 1 (Auth & Account System)          [Phase 0, Week 1-2]
    │
    └── Epic 2 (Key Provisioning)        [Phase 1, Week 3-4]
            │
            └── Epic 3 (SSH Connections)  [Phase 1, Week 4-5]
                    │
                    └── Epic 4 (Sessions) [Phase 2, Week 6-8]
                            │
                            └── Epic 7 (Migration)  [Phase 3, Week 10-11]

Epic 5 (Mobile UI)                       [Phase 1-2, Week 3-8, parallel]
    │                                      Can start with mocked API
    └── Connects to real API as Epics 1-4 land

Epic 6 (Security & Hardening)           [Phase 3, Week 9-10]
    │                                      After core functionality complete
    └── Depends on Epics 1-5
```

**Parallel work opportunities:**
- Epic 5 (UI) can run in parallel with Epics 1–4 using mocked API
- Epic 6 (Hardening) and Epic 7 (Migration) can partially overlap (weeks 9–11)
- Within Epic 3, issues #9 (CRUD) and #10 (test) can be developed in parallel by different engineers
- Within Epic 4, issues #14 (heartbeat) and #15 (close) can be developed in parallel once #13 (start) is done

---

## Total Estimate

| Epic | Points | Phase |
|------|--------|-------|
| 1: Auth & Account System | 12 | 0 |
| 2: Key Provisioning | 12 | 1 |
| 3: SSH Connection Management | 18 | 1 |
| 4: Session Lifecycle | 26 | 2 |
| 5: Mobile UI | 26 | 1–2 |
| 6: Security & Hardening | 21 | 3 |
| 7: Migration & Deprecation | 13 | 3 |
| **Total** | **128** | |

### Team Velocity Estimates

| Team Size | Velocity (pts/week) | Duration | Calendar |
|-----------|-------------------|----------|----------|
| **2 engineers** | ~12 pts/week | ~11 weeks | Weeks 1–11 |
| **1 engineer** | ~7 pts/week | ~18–20 weeks | Weeks 1–20 |
| **3 engineers** | ~17 pts/week | ~8 weeks | Weeks 1–8 |

**With 2 engineers (recommended):**
- Engineer A: Epics 1 → 2 → 3 → 4 → 6 (backend)
- Engineer B: Epic 5 (UI, parallel) → 7 (migration) → help with 6 (hardening)

---

## Risks & Mitigations

| # | Risk | Probability | Impact | Mitigation |
|---|------|-------------|--------|------------|
| R1 | **SSH ControlMaster behavior varies across server OS** | Medium | High | Test on Ubuntu 22.04, Debian 12, RHEL 9, Amazon Linux 2023, macOS. Document known issues. Fall back to per-command SSH connections if ControlMaster fails (slower but functional). |
| R2 | **Key encryption KMS integration delays** | Low | High | Start with `CLAWDFATHER_MASTER_KEY` env var (Phase 0–2). Add KMS envelope encryption in Phase 3. Env var approach is sufficient for staging/small deployments. Migration path: re-encrypt all keys when KMS available. |
| R3 | **Mobile OAuth WebView restrictions (iOS)** | Medium | Medium | Use `ASWebAuthenticationSession` on iOS (required for OAuth, works with system browser). Use Chrome Custom Tabs on Android. Test on iOS 16+, Android 12+. Fallback: open in Safari/Chrome directly with deep link callback. |
| R4 | **Host key TOFU UX confusion** | High | Medium | Clear copy: "Is this your server?" with server address visible. Link to help article explaining host keys. Fingerprint displayed in easy-to-compare format (groups of 4 hex chars). "What is this?" expandable section in TOFU dialog. |
| R5 | **Session orphan leak (ControlMaster processes)** | Low | High | 60-second cleanup job. Process monitoring: count ControlMaster processes vs. active session_leases — alert on mismatch. Socket file existence check in health endpoint. SIGTERM → 5s → SIGKILL escalation for stuck processes. |
| R6 | **GitHub OAuth rate limits** | Low | Low | Cache GitHub user info on first fetch (store in `oauth_identities`). Don't re-fetch on every request. Token refresh only when expired. If rate-limited: queue and retry with backoff. |
| R7 | **Database migration conflicts** | Low | Medium | Sequential migration files with timestamps. CI gate: migrations must pass on clean DB. Down migrations tested. Lock table during migration to prevent concurrent runs. |
| R8 | **OpenClaw agent runtime API changes** | Medium | High | Pin OpenClaw version. Abstract agent spawn behind an interface. Integration test that verifies agent can be spawned and receives context. If API changes: adapter pattern to translate. |
| R9 | **Private key temp file race condition** | Low | Critical | File created with `O_CREAT | O_EXCL` (atomic create, fail if exists). Mode 0600 set at creation. File deleted within 2 seconds (after ControlMaster socket appears). Directory `/tmp/clawdfather/` is mode 0700. Phase 3: investigate `memfd_create` (Linux) to avoid filesystem entirely. |
| R10 | **WebSocket reliability on mobile networks** | High | Medium | Exponential backoff reconnect. Heartbeat-based session keep-alive (not WebSocket ping alone). Session state is server-side (not WebSocket-dependent). Local message cache for chat history across reconnects. |

---

## PR Checklist Template

Every PR in this project should include:

- [ ] **Tests:** Unit tests for new functions. Integration tests for new endpoints.
- [ ] **Types:** No `any` types added (except for OpenClaw runtime interfaces which are untyped).
- [ ] **Audit logging:** New security-relevant operations log to audit_log.
- [ ] **Error handling:** All error paths return structured error response. No stack traces leaked.
- [ ] **Rate limits:** New endpoints have appropriate rate limits documented and enforced.
- [ ] **Validation:** Input validated and sanitized. SQL parameterized (no string interpolation).
- [ ] **Secrets:** No credentials, keys, or tokens in logs, error messages, or responses.
- [ ] **Migration:** If schema changes, up + down migration provided and tested.
- [ ] **Documentation:** API changes reflected in API Surface doc. New config vars documented.
