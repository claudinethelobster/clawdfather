# Session-First Chat-Centric UX — Detailed Design (PR #6)

## Overview

Clawdfather PR #6 adopts a **session-first** model with **agent-first pre-SSH** behaviour. The two key additions versus the prior design are:

1. **Agent available before SSH.** The chat agent is live from the moment the page loads — no server connection required. Users can ask questions, get help, and be guided through onboarding by the agent itself.
2. **Connectivity probe before install command.** Before showing the `authorized_keys` install snippet, the backend checks DNS resolution, TCP reachability, and SSH handshake. Failures are diagnosed with actionable guidance instead of cryptic errors.

These changes are codified in [ADR-002](../adr/ADR-002-agent-first-pre-ssh-onboarding.md).

---

## Chat-Led Onboarding — Ideal Path

The following transcript shows the happy path from first load to active session.

```
[App loads, user is authenticated]

Agent: 👋 I'm Clawdfather — your AI server admin.
       Which server do you want to manage?
       (e.g., "ubuntu@api.mycompany.com" or "my prod server")

User:  root@10.0.0.5

Agent: Checking if I can reach 10.0.0.5:22... ⏳

[probe runs in background — 2-5 seconds]

Agent: ✅ Port 22 is open on 10.0.0.5.
       Run this command on the server to install my SSH key:

       echo 'ssh-ed25519 AAAAC3Nz...' >> ~/.ssh/authorized_keys

       Say **Done** when you've run it. ⌛

User:  done

Agent: Testing connection to root@10.0.0.5... 🔍

Agent: ✅ Connected! I'm now talking to root@10.0.0.5.

       Want to give this server a nickname?
       (Or just say "no thanks" to skip)

User:  call it dev-box

Agent: Got it — I'll remember **dev-box**. Next time just say "connect to dev-box".

       What would you like to do?
```

### What happens under the hood

| Step | Frontend action | Backend call | DB writes |
|------|----------------|--------------|-----------|
| User provides target | Parse `root@10.0.0.5` → `{user, host, port}` | — | None |
| Probe | Show spinner | `POST /api/v1/connections/probe` | None |
| Show install cmd | Render command block | `POST /api/v1/sessions/bootstrap` | Creates keypair + connection (status: `pending`) |
| User says "Done" | Send confirm | `POST /api/v1/sessions/bootstrap/:id/confirm` | Updates connection status → `active`, creates session |
| Nickname | Send nickname | `PATCH /api/v1/connections/:id` | Updates connection `label` |

---

## Blocked Connectivity Path

When the probe detects a problem, the agent diagnoses it before wasting time on key installation.

### Port blocked

```
User:  deploy@api.mycompany.com

Agent: Checking if I can reach api.mycompany.com:22... ⏳

Agent: ❌ Port 22 on api.mycompany.com isn't reachable from here.

       This usually means one of:
       • The server is behind a firewall or VPN
       • SSH is running on a non-standard port
       • The hostname isn't publicly reachable yet

       A few options:
       1. Are you on a VPN? Try connecting to it first, then say "retry"
       2. Is SSH on a different port? Tell me (e.g., "it's on port 2222")
       3. Is there a bastion/jump host? Tell me (e.g., "jump through bastion.myco.com")

User:  it's on port 2222

Agent: Got it — checking api.mycompany.com:2222... ⏳

Agent: ✅ Port 2222 is open! Run this on your server:

       echo 'ssh-ed25519 AAAAC3Nz...' >> ~/.ssh/authorized_keys

       Say **Done** when you've run it. ⌛
```

### DNS failure

```
User:  admin@myserver.local

Agent: Checking if I can reach myserver.local:22... ⏳

Agent: ❌ I can't resolve "myserver.local" — the hostname doesn't exist in public DNS.

       This could mean:
       • It's a local/private hostname (only reachable on your network)
       • There's a typo in the hostname

       Can you give me the IP address instead? (e.g., "192.168.1.50")

User:  192.168.1.50

Agent: Checking 192.168.1.50:22... ⏳

Agent: ❌ Port 22 on 192.168.1.50 isn't reachable from here.
       That IP looks like a private/LAN address — I can only reach
       publicly routable servers. Is this machine behind a NAT or router?
```

### SSH handshake failure

```
User:  root@webserver.example.com:8080

Agent: Checking webserver.example.com:8080... ⏳

Agent: ⚠️ Port 8080 is open on webserver.example.com, but it doesn't
       appear to be running SSH — it looks like an HTTP server.

       Is SSH maybe on the default port 22? Or a different port?

User:  try 22

Agent: Checking webserver.example.com:22... ⏳

Agent: ✅ Port 22 is open and speaking SSH! Run this on your server:
       ...
```

### User override

```
Agent: ❌ Port 22 on secure.myco.com isn't reachable from here.
       ...

User:  I know it's reachable, my firewall just blocks probes. Skip the check.

Agent: No problem — I'll skip the connectivity check and show you
       the install command directly.

       Run this on secure.myco.com:

       echo 'ssh-ed25519 AAAAC3Nz...' >> ~/.ssh/authorized_keys

       Say **Done** when you've run it. ⌛
```

---

## Key Identity Model

Consistent with ADR-002:

- **One Ed25519 keypair per account**, auto-generated at signup.
- The private key never leaves the backend.
- The public key is embedded in the install command shown to users.
- If a user needs to rotate their key, the agent handles it (generates a new pair, shows a new install command, removes the old key from `authorized_keys` via SSH).

This means:

- Users never generate, copy, or manage SSH keys themselves.
- The same key works across all of a user's servers.
- Key rotation is an agent-guided conversation, not a settings page.

---

## UI Layout

### Design principles

1. **Single screen after login.** The entire app is one chat thread.
2. **Mobile-first.** Touch targets, safe-area insets, no hover-dependent interactions.
3. **No tabs, no FAB, no drawer.** Navigation is conversational ("connect to dev-box", "end session", "show my servers").

### Layout structure

```
┌─────────────────────────────────────────┐
│  🦞 CLAWDFATHER │ dev-box (root)  │ End │  ← header
├─────────────────────────────────────────┤
│                                         │
│  [chat messages scroll here]            │  ← full-height thread
│                                         │
│  Agent: ✅ Connected to dev-box         │
│  Agent: What would you like to do?      │
│                                         │
│  User: show disk usage                  │
│  Agent: Here's `df -h` output:          │
│  ┌───────────────────────────────────┐  │
│  │ /dev/sda1  50G  32G  16G  67%    │  │  ← code block
│  └───────────────────────────────────┘  │
│                                         │
├─────────────────────────────────────────┤
│  [Type a message...]            [Send]  │  ← input bar
│                                         │     (safe-area aware)
└─────────────────────────────────────────┘
```

### Header states

| State            | Header content                                  |
|------------------|------------------------------------------------|
| No session       | `🦞 CLAWDFATHER`                                |
| Probing          | `🦞 CLAWDFATHER │ Connecting...`                |
| Active session   | `🦞 CLAWDFATHER │ dev-box (root@10.0.0.5) │ End`|
| Session ended    | `🦞 CLAWDFATHER │ Session ended`                |

### Responsive behaviour

- **Mobile (< 640px):** Full-width chat, bottom input pinned above keyboard, header collapses server info to icon.
- **Tablet / Desktop (≥ 640px):** Centered chat column (max 720px), comfortable reading width.

---

## API Design

### Connectivity probe

```
POST /api/v1/connections/probe
```

Pre-checks a target host before any DB records are created. Used by the agent to decide whether to show the install command or troubleshoot.

**Request body:**

```json
{
  "host": "api.mycompany.com",
  "port": 22
}
```

**Response:**

```json
{
  "status": "connectable",
  "latency_ms": 142,
  "error_detail": null
}
```

Possible `status` values: `connectable`, `dns_fail`, `port_fail`, `ssh_fail`, `already_authorized`.

### Full onboarding flow

#### 1. Bootstrap

```
POST /api/v1/sessions/bootstrap
```

Creates a keypair (if the user doesn't have one) and a connection record. Returns the install command.

**Request body:**

```json
{
  "user": "root",
  "host": "10.0.0.5",
  "port": 22,
  "label": null
}
```

**Response:**

```json
{
  "connection_id": "conn_abc123",
  "status": "awaiting_install",
  "install_command": "echo 'ssh-ed25519 AAAA...' >> ~/.ssh/authorized_keys",
  "public_key": "ssh-ed25519 AAAA..."
}
```

If the key is already authorized:

```json
{
  "connection_id": "conn_abc123",
  "status": "ready",
  "install_command": null,
  "public_key": "ssh-ed25519 AAAA..."
}
```

#### 2. Confirm

```
POST /api/v1/sessions/bootstrap/:connection_id/confirm
```

Tests SSH authentication. On success, creates a session and returns its ID.

**Response (success):**

```json
{
  "status": "active",
  "session_id": "sess_xyz789",
  "server_info": {
    "os": "Ubuntu 22.04.3 LTS",
    "hostname": "dev-box",
    "uptime": "42 days"
  }
}
```

**Response (failure):**

```json
{
  "status": "auth_fail",
  "session_id": null,
  "error_detail": "Permission denied (publickey)"
}
```

---

## State Management

The frontend tracks the onboarding state machine from ADR-002 using a simple reducer:

| Current state        | Event                  | Next state             |
|----------------------|------------------------|------------------------|
| `greeting`           | User provides target   | `collect_target`       |
| `collect_target`     | Target parsed          | `probing`              |
| `probing`            | Probe → connectable    | `awaiting_install`     |
| `probing`            | Probe → dns_fail       | `troubleshoot_dns`     |
| `probing`            | Probe → port_fail      | `troubleshoot_port`    |
| `probing`            | Probe → ssh_fail       | `troubleshoot_service` |
| `probing`            | Probe → already_auth   | `starting_session`     |
| `troubleshoot_*`     | User provides fix      | `probing` (re-probe)   |
| `awaiting_install`   | User says "Done"       | `confirm_and_connect`  |
| `confirm_and_connect`| SSH success            | `active_session`       |
| `confirm_and_connect`| SSH auth_fail          | `re_show_install`      |
| `confirm_and_connect`| SSH timeout            | `troubleshoot_firewall`|
| `active_session`     | User ends / timeout    | `closed`               |
| `closed`             | User says "reconnect"  | `probing`              |

---

## Error Handling Philosophy

1. **Never show raw SSH errors to the user.** The agent translates every error into plain language with a suggested next step.
2. **Probe before commit.** Don't create DB records until connectivity is confirmed.
3. **Allow override.** If the user insists the host is reachable despite a failed probe, let them proceed.
4. **Retry-friendly.** Every troubleshooting state loops back to `probing` after the user provides new info — no dead ends.

---

## Future Considerations

- **Bastion / jump-host support.** The probe and bootstrap APIs could accept an optional `proxy` field for ProxyJump configurations.
- **Agent-initiated reconnect.** If an active session drops, the agent could automatically re-probe and reconnect without user intervention.
- **Multi-server sessions.** Allow users to say "also connect to db-server" during an active session, managing multiple SSH connections in one chat.
