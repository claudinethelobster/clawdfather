# Execution Architecture

> Clawdfather — Mobile-First Account-Based SSH Orchestration

---

## 5.1 Agent Runtime Binding

### Session Start Flow

When a user taps "Start Session" for a connection, the following sequence executes server-side:

```
  Mobile App                  API Server                    Filesystem / OS                OpenClaw Runtime
      │                           │                               │                              │
  POST /sessions                  │                               │                              │
  { connection_id }               │                               │                              │
      │──────────────────────────►│                               │                              │
      │                           │                               │                              │
      │                     1. Validate connection                │                              │
      │                        (tested, key active)              │                              │
      │                           │                               │                              │
      │                     2. INSERT session_leases              │                              │
      │                        status='pending'                  │                              │
      │                           │                               │                              │
      │                     3. Decrypt private key               │                              │
      │                        (KEK from KMS + account_id)       │                              │
      │                           │                               │                              │
      │                     4. Write temp key file               │                              │
      │                           │──────────────────────────────►│                              │
      │                           │  /tmp/clawdfather/{sid}.key   │                              │
      │                           │  mode: 0600                   │                              │
      │                           │                               │                              │
      │                     5. Write temp known_hosts            │                              │
      │                           │──────────────────────────────►│                              │
      │                           │  /tmp/clawdfather/{sid}.kh    │                              │
      │                           │  Contains pinned host key     │                              │
      │                           │                               │                              │
      │                     6. Spawn ControlMaster               │                              │
      │                           │──────────────────────────────►│                              │
      │                           │  ssh -N \                     │                              │
      │                           │    -o ControlMaster=yes \     │                              │
      │                           │    -o ControlPath=...sock \   │                              │
      │                           │    -i /tmp/.../sid.key \      │                              │
      │                           │    -o UserKnownHostsFile=...  │                              │
      │                           │    user@host                  │                              │
      │                           │                               │                              │
      │                     7. Wait for socket file              │                              │
      │                           │◄──────────────────────────────│                              │
      │                           │  Socket ready                 │                              │
      │                           │                               │                              │
      │                     8. Delete temp key + known_hosts     │                              │
      │                           │──────────────────────────────►│                              │
      │                           │                               │                              │
      │                     9. Spawn agent session               │                              │
      │                           │──────────────────────────────────────────────────────────────►│
      │                           │  Context payload:             │                              │
      │                           │  { connection_id,             │                              │
      │                           │    host, port, username,      │                              │
      │                           │    keypair_id,                │                              │
      │                           │    session_lease_id,          │                              │
      │                           │    control_path }             │                              │
      │                           │                               │                              │
      │                    10. UPDATE session_leases              │                              │
      │                        status='active'                   │                              │
      │                        started_at=NOW()                  │                              │
      │                        agent_session_id=...              │                              │
      │                           │                               │                              │
      │◄──────────────────────────│                               │                              │
      │  { session: { id,        │                               │                              │
      │    status, chat_url } }  │                               │                              │
```

### Agent Context Payload

The OpenClaw agent receives this context when spawned:

```json
{
  "connection_id": "770e8400-e29b-41d4-a716-446655440002",
  "host": "192.168.1.100",
  "port": 22,
  "username": "deploy",
  "keypair_id": "660e8400-e29b-41d4-a716-446655440001",
  "session_lease_id": "880e8400-e29b-41d4-a716-446655440003",
  "control_path": "/tmp/clawdfather/880e8400-e29b-41d4-a716-446655440003.sock"
}
```

### SSH Command Execution via ControlMaster

The agent's `exec` tool calls are prefixed with the SSH ControlMaster command via environment injection:

```bash
ssh -o ControlPath=/tmp/clawdfather/{session_lease_id}.sock \
    -o ControlMaster=no \
    -p {port} \
    {username}@{host} \
    -- <user_command>
```

This is injected as an environment variable into the agent runtime:

```
CLAWDFATHER_SSH_PREFIX=ssh -o ControlPath=/tmp/clawdfather/880e8400...sock -o ControlMaster=no -p 22 deploy@192.168.1.100 --
```

The OpenClaw exec tool prepends this prefix to all commands, so when the agent runs `ls -la /etc`, the actual execution is:

```bash
ssh -o ControlPath=/tmp/clawdfather/880e8400...sock -o ControlMaster=no -p 22 deploy@192.168.1.100 -- ls -la /etc
```

ControlMaster multiplexes all SSH connections through the existing master socket — no additional SSH handshakes or auth for each command.

### ControlMaster Socket Paths

```
/tmp/clawdfather/
├── 880e8400-e29b-41d4-a716-446655440003.sock   # ControlMaster socket
├── 990e8400-e29b-41d4-a716-446655440004.sock   # Another active session
└── (temp files deleted after ControlMaster established)
```

- Directory: `/tmp/clawdfather/` created with mode `0700` on server startup
- Socket path: `/tmp/clawdfather/{session_lease_id}.sock`
- Socket permissions: inherited from directory (0700) — only the server process user can access
- UUID in path ensures unpredictability (no enumeration)

---

## 5.2 Process Model

### Process Tree

```
API Server (Node.js)
├── SSH ControlMaster (per active session)
│   └── ssh -N -o ControlMaster=yes -o ControlPath=<sock> user@host
│       (child process of API server, backgrounded with -N)
├── OpenClaw Agent Runtime (per active session)
│   └── Agent uses exec tool → ssh -o ControlPath=<sock> ... -- <cmd>
│       (command execution via ControlMaster multiplexing)
└── Cleanup Job (setInterval, every 60s)
    └── Checks for orphaned sessions and ControlMasters
```

### ControlMaster Lifecycle

**Startup:**
```bash
ssh -N \
  -o ControlMaster=yes \
  -o ControlPath=/tmp/clawdfather/{session_lease_id}.sock \
  -o ControlPersist=no \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ConnectTimeout=10 \
  -o UserKnownHostsFile=/tmp/clawdfather/{session_lease_id}.kh \
  -i /tmp/clawdfather/{session_lease_id}.key \
  -p {port} \
  {username}@{host}
```

Flags explained:
- `-N`: No remote command — just maintain the connection
- `ControlMaster=yes`: This process owns the socket
- `ControlPersist=no`: Socket dies when this process exits (no orphan sockets)
- `ServerAliveInterval=30`: Send keepalive every 30s
- `ServerAliveCountMax=3`: Disconnect after 3 missed keepalives (90s unresponsive)
- `ConnectTimeout=10`: Fail fast if host unreachable

**Teardown (graceful — user closes session or timeout):**
```bash
ssh -S /tmp/clawdfather/{session_lease_id}.sock -O exit {username}@{host}
```

Then:
1. Unlink socket file
2. Kill ControlMaster process if still alive (SIGTERM → 5s → SIGKILL)
3. Update `session_leases`: `status = 'closed'`, `closed_at = NOW()`

**Teardown (force — orphan cleanup):**
1. Check if socket file exists: `ssh -S <sock> -O check user@host`
2. If alive but session_lease shows stale heartbeat: send `-O exit`
3. If process is gone but socket file remains: `unlink(socket_path)`
4. Update session_lease: `status = 'closed'`, `close_reason = 'timeout'`

### Orphan Cleanup Job

Runs every 60 seconds as a `setInterval` in the API server process:

```
For each session_lease WHERE status = 'active':
  1. Check last_heartbeat_at
  2. If NOW() - last_heartbeat_at > 2 minutes:
     a. Check if ControlMaster socket exists
     b. If socket exists:
        - Send `ssh -O exit` to close gracefully
        - Unlink socket
     c. If socket missing:
        - Process already gone, just update DB
     d. Update session_lease:
        - status = 'closed'
        - close_reason = 'timeout'
        - closed_at = NOW()
     e. Close WebSocket connections for this session
     f. Audit log: session.timeout
```

The 2-minute threshold (vs. the 5-minute user-facing grace period) accounts for the cleanup job's 60-second interval — worst case, a session is cleaned up ~3 minutes after the last heartbeat, well within the 5-minute grace window.

---

## 5.3 Reconnect Semantics

### Session Durability

Session IDs are durable UUIDs stored in `session_leases`. As long as the session_lease has `status = 'active'` and the ControlMaster socket is alive, a client can re-attach.

### Reconnect Flow

```
  Mobile App (foreground)            API Server                WebSocket
        │                               │                         │
  1. App foregrounded                   │                         │
        │                               │                         │
  2. GET /sessions?status=active        │                         │
        │──────────────────────────────►│                         │
        │◄──────────────────────────────│                         │
        │  [{ id, status, chat_url }]   │                         │
        │                               │                         │
  3. For each active session:           │                         │
        │                               │                         │
  4. Connect WebSocket                  │                         │
        │──────────────────────────────────────────────────────►│
        │                               │                         │
  5. Send auth message                  │                         │
        │──────────────────────────────────────────────────────►│
        │  { type: "auth", token: "clf_..." }                    │
        │                               │                         │
  6. Server validates session + token   │                         │
        │◄──────────────────────────────────────────────────────│
        │  { type: "session", ... }     │                         │
        │                               │                         │
  7. Resume chat                        │                         │
```

### Auto-Reconnect Strategy

When WebSocket disconnects (network change, app background/foreground cycle):

| Attempt | Delay | Action |
|---------|-------|--------|
| 1 | 1 second | Reconnect WebSocket |
| 2 | 2 seconds | Reconnect WebSocket |
| 3 | 4 seconds | Reconnect WebSocket |
| 4 | 8 seconds | Reconnect WebSocket |
| 5 | 16 seconds | Reconnect WebSocket |
| 6 | 30 seconds | Reconnect WebSocket |
| 7+ | 30 seconds | Reconnect WebSocket (cap at 30s) |
| After 60s total | — | Show "Unable to reconnect" with manual retry button |

On each reconnect attempt:
1. Check if session is still active: `GET /api/v1/sessions/:id` → if `status != 'active'`, show "Session expired"
2. If active, re-establish WebSocket and re-authenticate

### Session Expiry

- **Idle timeout:** 30 minutes (configurable per account via settings, range: 5 min – 4 hours)
- **Timeout basis:** Time since last heartbeat (`last_heartbeat_at`), not wall-clock time since start
- **Heartbeat sources:** WebSocket ping (every 30s from client), any API call that references the session
- **Grace period:** 5 minutes after last heartbeat before ControlMaster teardown
- **Reconnect window:** Client can reconnect any time before ControlMaster teardown

### Timeline

```
  t=0           t=30min        t=30min+5min    t=30min+5min+60s
   │               │               │                │
   │  Session      │  Idle timeout  │  Grace period  │ Cleanup job runs
   │  active       │  reached       │  expires       │ ControlMaster torn down
   │  heartbeats   │  (last HB      │  (no reconnect)│ session_lease → closed
   │  flowing      │  was at t=0)   │                │
   │               │                │                │
   └───────────────┴────────────────┴────────────────┘
```

---

## 5.4 Timeout Strategy

### SSH Timeouts

| Timeout | Value | Config Flag | Purpose |
|---------|-------|-------------|---------|
| **Connect timeout** | 10 seconds | `ConnectTimeout=10` | Fail fast if host unreachable during ControlMaster setup |
| **Connection test timeout** | 15 seconds | `ConnectTimeout=15` | Slightly more lenient for user-initiated tests (may be slower networks) |
| **Keepalive interval** | 30 seconds | `ServerAliveInterval=30` | Detect dead connections (server crashed, network dropped) |
| **Keepalive count** | 3 missed | `ServerAliveCountMax=3` | Total unresponsive tolerance: 90 seconds before ControlMaster disconnects |
| **ControlPersist** | disabled | `ControlPersist=no` | Socket dies with master process — prevents orphan sockets |
| **Command timeout** | 120 seconds | Application-level | Individual `exec` commands killed after 120s (configurable per command) |

### Application Timeouts

| Timeout | Value | Purpose |
|---------|-------|---------|
| **API request timeout** | 30 seconds | Maximum time for any API endpoint to respond |
| **Session start timeout** | 30 seconds | Maximum time from `POST /sessions` to `status = 'active'` (includes SSH connect + agent spawn) |
| **Session idle timeout** | 30 minutes (default) | No heartbeat for this duration triggers grace period |
| **Session grace period** | 5 minutes | After idle timeout, time before ControlMaster teardown |
| **Orphan cleanup interval** | 60 seconds | How often the cleanup job scans for stale sessions |
| **Orphan detection threshold** | 2 minutes | Heartbeat age that triggers cleanup (accounts for cleanup interval) |
| **WebSocket ping interval** | 30 seconds | Client sends heartbeat over WebSocket |
| **WebSocket reconnect cap** | 60 seconds | Maximum total time spent reconnecting before giving up |
| **OAuth state TTL** | 10 minutes | State parameter expires after this (prevents stale OAuth flows) |
| **Temp key file window** | ~2 seconds typical, 10s max | Time private key exists as plaintext file |

### Timeout Hierarchy

```
Command execution (120s)
  └── within Session (30 min idle)
        └── within ControlMaster (90s keepalive death)
              └── within API request (30s)

If ControlMaster dies (90s no keepalive):
  → Session enters error state
  → All pending commands fail
  → Client notified via WebSocket

If Session times out (30 min idle):
  → ControlMaster torn down
  → Agent session terminated
  → WebSocket closed with reason
```

---

## 5.5 Observability Requirements

### Structured Logging

Every log line is JSON with these standard fields:

```json
{
  "timestamp": "2026-02-21T17:00:00.123Z",
  "level": "info|warn|error",
  "component": "api|ssh|session|cleanup|auth",
  "event": "ssh.connect|ssh.exec|ssh.disconnect|session.start|...",
  "session_lease_id": "880e8400...",
  "account_id": "550e8400...",
  "connection_id": "770e8400...",
  "trace_id": "abc123...",
  "message": "Human-readable description",
  "detail": {}
}
```

**SSH-specific log events:**

| Event | Level | When | Detail Fields |
|-------|-------|------|---------------|
| `ssh.connect.start` | info | ControlMaster spawn initiated | `host`, `port`, `username` |
| `ssh.connect.success` | info | ControlMaster socket ready | `host`, `port`, `latency_ms` |
| `ssh.connect.failed` | error | ControlMaster failed to establish | `host`, `port`, `error`, `stderr` |
| `ssh.exec.start` | debug | Command execution started | `command_hash` (SHA-256, not raw command for security) |
| `ssh.exec.complete` | info | Command execution finished | `exit_code`, `duration_ms`, `stdout_bytes`, `stderr_bytes` |
| `ssh.exec.timeout` | warn | Command exceeded timeout | `timeout_ms`, `command_hash` |
| `ssh.keepalive.failed` | warn | ControlMaster keepalive missed | `missed_count` |
| `ssh.disconnect` | info | ControlMaster connection closed | `reason` (exit/error/keepalive) |

### Metrics (Prometheus-Compatible)

Exported at `GET /metrics` (Prometheus scrape endpoint, no auth required from internal network).

**Gauges:**

| Metric | Labels | Description |
|--------|--------|-------------|
| `clawdfather_active_sessions` | — | Number of session_leases with status=active |
| `clawdfather_active_controlmasters` | — | Number of ControlMaster socket files present |
| `clawdfather_connected_websockets` | — | Number of open WebSocket connections |

**Counters:**

| Metric | Labels | Description |
|--------|--------|-------------|
| `clawdfather_session_start_total` | `result={ok,failed}` | Total session start attempts |
| `clawdfather_session_close_total` | `reason={user,timeout,error,server_closed}` | Total session closures by reason |
| `clawdfather_session_error_total` | `error_type={ssh_connect,agent_spawn,runtime}` | Total session errors by type |
| `clawdfather_connection_test_total` | `result={ok,failed,timeout,host_key_changed}` | Connection test results |
| `clawdfather_auth_total` | `result={ok,failed}, provider={github}` | OAuth callback results |
| `clawdfather_ssh_exec_total` | `result={ok,failed,timeout}` | SSH command execution results |
| `clawdfather_cleanup_runs_total` | — | Number of cleanup job executions |
| `clawdfather_orphan_sessions_cleaned_total` | — | Number of orphaned sessions cleaned up |

**Histograms:**

| Metric | Buckets (ms) | Description |
|--------|-------------|-------------|
| `clawdfather_ssh_connect_latency_ms` | 100, 250, 500, 1000, 2500, 5000, 10000 | Time from ControlMaster spawn to socket ready |
| `clawdfather_ssh_exec_duration_ms` | 50, 100, 250, 500, 1000, 5000, 30000, 120000 | Individual command execution time |
| `clawdfather_api_request_duration_ms` | 10, 50, 100, 250, 500, 1000, 5000 | API endpoint response time |
| `clawdfather_session_duration_minutes` | 1, 5, 10, 30, 60, 120, 240 | Total session lifetime (start to close) |

### Health Endpoint

`GET /health` — returns system health status:

```json
{
  "status": "ok",
  "checks": {
    "db": {
      "status": "ok",
      "latency_ms": 2
    },
    "filesystem": {
      "status": "ok",
      "tmp_writable": true,
      "tmp_space_mb": 4096
    }
  },
  "active_sessions": 3,
  "active_controlmasters": 3,
  "connected_websockets": 5,
  "version": "0.2.0",
  "uptime_s": 86400
}
```

**Health check logic:**
1. PostgreSQL: `SELECT 1` with 5s timeout
2. Filesystem: Write + read + delete test file in `/tmp/clawdfather/`
3. Active sessions count: query `session_leases WHERE status = 'active'`
4. ControlMasters: count `.sock` files in `/tmp/clawdfather/`

**Status values:**
- `ok`: All checks pass
- `degraded`: Non-critical check failed (e.g., high latency but functional)
- `unhealthy`: Critical check failed (DB unreachable)

Returns HTTP 200 for `ok`/`degraded`, HTTP 503 for `unhealthy`.

### Tracing (Phase 2)

OpenTelemetry integration for distributed tracing:

| Span | Parent | Attributes |
|------|--------|------------|
| `api.request` | root | `http.method`, `http.route`, `http.status_code` |
| `auth.validate_token` | `api.request` | `account_id` |
| `ssh.connect` | `api.request` (session start) | `host`, `port`, `duration_ms` |
| `ssh.exec` | `agent.process_message` | `command_hash`, `exit_code`, `duration_ms` |
| `agent.spawn` | `api.request` (session start) | `agent_session_id` |
| `agent.process_message` | root (WebSocket) | `session_lease_id`, `message_length` |
| `db.query` | varies | `table`, `operation`, `duration_ms` |

Trace context propagated via `traceparent` header for HTTP, custom attribute for WebSocket messages.

### Alerting Rules

| Alert | Condition | Severity | Channel |
|-------|-----------|----------|---------|
| **High error rate** | `rate(session_error_total[5m]) > 0.05 * rate(session_start_total[5m])` | P1 | PagerDuty |
| **API latency p99 > 5s** | `histogram_quantile(0.99, api_request_duration_ms) > 5000` | P2 | Slack |
| **SSH connect latency p99 > 8s** | `histogram_quantile(0.99, ssh_connect_latency_ms) > 8000` | P2 | Slack |
| **No active sessions (unexpected)** | `active_sessions == 0` during business hours (if normally >0) | P3 | Slack |
| **Orphan session spike** | `rate(orphan_sessions_cleaned_total[10m]) > 5` | P2 | Slack |
| **DB health failed** | Health endpoint returns `unhealthy` | P1 | PagerDuty |
| **Cleanup job not running** | `time() - cleanup_runs_total last increase > 180` (3 min) | P2 | Slack |
| **Disk space low** | `/tmp` filesystem <500MB free | P2 | Slack |
