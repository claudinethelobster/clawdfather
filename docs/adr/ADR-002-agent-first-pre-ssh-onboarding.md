# ADR-002: Agent-First Pre-SSH Onboarding with Connectivity Probe

| Field  | Value                          |
|--------|--------------------------------|
| Status | Accepted                       |
| Date   | 2026-02-22                     |
| Author | Claudine (OpenClaw Agent)      |

---

## Context

Clawdfather is an AI-powered SSH admin tool. Prior to this ADR, the onboarding UX required:

1. User opens the web app.
2. User navigates to a "Connections" form (or follows a chat prompt).
3. User enters target `user@host:port`.
4. App shows an `authorized_keys` install command.
5. User runs the install command on the server.
6. User clicks "Test Connection" or says "Done".
7. If the test passes, the session starts.

### Problems with this flow

- **The agent is not available until after SSH is set up.** If a user is confused during onboarding, there is no agent to help them.
- **The app shows the install command without first checking if the host is even reachable** — leading to confusing "Connection refused" errors that feel like key-installation problems.
- Users with firewalls, VPN requirements, or non-standard ports get a cryptic SSH error at step 6 with no actionable guidance.
- The UX feels like "fill out a form" rather than "talk to an assistant".

---

## Decision

Adopt the **agent-first, pre-SSH** model. Key tenets:

### 1. Agent available from page load

When the user opens Clawdfather, the chat agent is immediately available — before any server is connected. The agent can answer questions, guide onboarding, explain errors, and troubleshoot without needing an active SSH session.

### 2. Connectivity probe before install command

When a user wants to connect to a server, the agent (or UI) runs a connectivity probe **before** showing the `authorized_keys` install command:

| Check              | Purpose                                      |
|--------------------|----------------------------------------------|
| DNS resolution     | Can we resolve the hostname?                 |
| TCP port probe     | Is port 22 (or the custom port) reachable?   |
| SSH handshake      | Does the server speak SSH?                   |

If the probe fails, the agent explains **why** and what to do (e.g., "Port 22 isn't reachable from here — is this server behind a firewall or VPN?") — before asking the user to run any install command.

### 3. Branch on probe result

| Result               | Action                                                                 |
|----------------------|------------------------------------------------------------------------|
| `connectable`        | Proceed directly to showing install command and asking user to run it. |
| `dns_fail`           | Ask for IP address, check if hostname is correct.                      |
| `port_fail`          | Ask about firewall rules, VPN, custom port, or bastion host.           |
| `ssh_fail`           | Warn that the port may be running a different service.                 |
| `already_authorized` | Skip to session start (connection previously set up).                  |

### 4. One screen: chat

No separate Connections tab, no Keys tab. Everything happens in the chat.

### 5. Implicit records

Connections and keypairs are stored in the DB automatically when onboarding succeeds — the user never touches forms.

---

## Consequences

### Positive

- The agent can help users who get stuck during onboarding — dramatically reducing drop-off.
- Connectivity failures are diagnosed before the user wastes time installing an SSH key that won't work anyway.
- The UX feels like live agent assistance, not form-filling.
- Single-screen simplicity works identically on mobile and desktop.

### Negative / Mitigations

- **Probe latency.** The connectivity probe adds ~2–5 s latency before showing the install command. *Mitigation:* show "Checking connectivity to your server... ⏳" while probing.
- **False negatives.** The probe can produce false negatives if ICMP is blocked (we use TCP, not ping, so this is less likely). *Mitigation:* if the probe says blocked but the user says they know it's reachable, allow them to override and proceed to key install anyway.

---

## Onboarding State Machine

```
[greeting]    — agent greets user, asks which server to connect to
      │
      ▼
[collect_target]  — user says "connect to user@host" or provides details
      │
      ▼
[probing]     — backend runs DNS + TCP + SSH handshake probe
      │         (shows "Checking connectivity..." in chat)
      ├──[dns_fail]────────────────────────────────────────────▶ [troubleshoot_dns]
      │                                                                │ user provides IP
      │                                                                ▼
      ├──[port_fail]───────────────────────────────────────────▶ [troubleshoot_port]
      │                                                                │ user confirms VPN / port
      │                                                                ▼
      ├──[ssh_fail]────────────────────────────────────────────▶ [troubleshoot_service]
      │
      ├──[already_authorized]──────────────────────────────────▶ [starting_session]
      │
      └──[connectable]
              │
              ▼
[awaiting_install]  — shows install command, waits for user to say "Done"
      │
      ▼
[confirm_and_connect]  — backend tests SSH, starts session on success
      │
      ├──[auth_fail]──────────────────────────────────────────▶ [re_show_install]
      ├──[timeout]────────────────────────────────────────────▶ [troubleshoot_firewall]
      │
      └──[success]
              │
              ▼
[active_session]  — normal admin chat with SSH context injected per-turn
      │
      ▼
[closed]      — user says "end session" or timeout
```

### State descriptions

| State                  | Entry trigger           | Agent behaviour                                                  |
|------------------------|-------------------------|------------------------------------------------------------------|
| `greeting`             | Page load               | Welcome message, ask for target server.                          |
| `collect_target`       | User provides host info | Parse `user@host:port`, prompt for missing fields.               |
| `probing`              | Target accepted         | Call `/api/v1/connections/probe`, show spinner.                  |
| `troubleshoot_dns`     | Probe → `dns_fail`     | Ask if hostname is correct, offer to try an IP.                  |
| `troubleshoot_port`    | Probe → `port_fail`    | Ask about firewall, VPN, non-standard port.                     |
| `troubleshoot_service` | Probe → `ssh_fail`     | Warn port may not be SSH, offer to try another port.             |
| `awaiting_install`     | Probe → `connectable`  | Show install command, wait for "Done".                           |
| `confirm_and_connect`  | User says "Done"       | Test SSH auth, create DB records on success.                     |
| `re_show_install`      | Auth failed             | Re-display command, suggest common mistakes.                     |
| `active_session`       | SSH confirmed           | Full admin chat with SSH context per turn.                       |
| `closed`               | User ends / timeout     | Tear down SSH, offer to reconnect.                               |

---

## API Surface Added

### `POST /api/v1/connections/probe`

Run a connectivity probe for a given host and port **without** creating any DB records.

**Request:**

```json
{
  "host": "api.mycompany.com",
  "port": 22
}
```

**Response:**

```json
{
  "status": "connectable | dns_fail | port_fail | ssh_fail | already_authorized",
  "latency_ms": 142,
  "error_detail": null
}
```

### `POST /api/v1/sessions/bootstrap`

Auto-provision a keypair and connection record. Returns the install command (or `status: 'ready'` if the key is already authorized).

**Request:**

```json
{
  "user": "root",
  "host": "10.0.0.5",
  "port": 22
}
```

**Response:**

```json
{
  "connection_id": "conn_abc123",
  "status": "awaiting_install | ready",
  "install_command": "echo 'ssh-ed25519 AAAA...' >> ~/.ssh/authorized_keys"
}
```

### `POST /api/v1/sessions/bootstrap/:connection_id/confirm`

Test SSH inline and start a session if the key is accepted.

**Response:**

```json
{
  "status": "active | auth_fail | timeout",
  "session_id": "sess_xyz789"
}
```

---

## Comparison with PR #5 (`feat/mobile-auth-overhaul`)

| Aspect              | PR #5                          | PR #6 (This ADR)                              |
|---------------------|--------------------------------|------------------------------------------------|
| Agent availability  | After SSH connected            | Immediately on page load                       |
| Connectivity check  | After key install              | Before key install (probe step)                |
| Blocked-host UX     | Generic SSH error              | Specific probe result + guidance               |
| Commit history      | Mixed (25 commits)             | Clean logical commits                          |
| UI model            | Mostly chat, some form remnants| Pure chat, no forms                            |

---

## References

- ADR-001 (implied): Original connection-first onboarding model.
- PR #5 `feat/mobile-auth-overhaul`: prior implementation attempt.
- PR #6 `feat/session-first-mobile-v2`: implementation of this ADR.
