# 08 — Session-First Chat-Centric UX: Detailed Design

> **Related:** [ADR-001](../adr/ADR-001-session-first-chat-model.md) · [Migration Guide](../migration/session-first-migration.md)

---

## Overview

The session-first model treats every interaction as a session. The unit of value is **"I am talking to my server right now"** — not "I have a saved connection record."

There is no connections list to browse, no keys screen to manage, no settings drawer to configure. The user opens Clawdfather, sees a chat thread, and starts talking. If they need a server, they say so. If they need to check something, they ask. The AI handles everything behind the scenes — creating keys, saving connections, managing sessions — while the user stays in a single, continuous conversation.

This design is informed by how people actually use mobile SSH: sporadically, urgently, and with minimal patience for setup friction. The chat-first model optimizes for time-to-first-command.

---

## Chat-Led SSH Onboarding Flow

### Happy Path

```
User: connect to my api server
AI:   What's the user and hostname? (e.g., deploy@api.mycompany.com)

User: ubuntu@10.0.0.5
AI:   Got it. Run this command on ubuntu@10.0.0.5 to install my key:

      echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...' >> ~/.ssh/authorized_keys

      Say **Done** when you've run it. ⌛

User: done
AI:   Testing connection to ubuntu@10.0.0.5... 🔄

      ✅ Connected! I'm now talking to ubuntu@10.0.0.5.

      Want to give this server a name? (e.g., "api server", "prod")

User: call it api-prod
AI:   Got it — I'll remember this as **api-prod**. Next time just say "connect to api-prod".

      What would you like to do on this server?
```

### Alternative Flows

#### User provides user@host upfront

When the initial message already contains a parseable `user@host`, the AI skips asking for it:

```
User: ssh into deploy@staging.myapp.io
AI:   Run this command on deploy@staging.myapp.io to install my key:

      echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...' >> ~/.ssh/authorized_keys

      Say **Done** when you've run it. ⌛
```

#### Test fails — authentication error

The most common failure: the key wasn't installed correctly.

```
User: done
AI:   Testing connection to ubuntu@10.0.0.5... 🔄

      ❌ Authentication failed — the server didn't accept my key.

      This usually means the install command wasn't run, or was run as a
      different user. Make sure you run it as **ubuntu** on **10.0.0.5**:

      echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...' >> ~/.ssh/authorized_keys

      Try again and say **Done** when ready.
```

#### Test fails — connection timeout

```
User: done
AI:   Testing connection to ubuntu@10.0.0.5... 🔄

      ❌ Connection timed out — I couldn't reach the server.

      A few things to check:
      • Is SSH running on port 22?
      • Is 10.0.0.5 reachable from the internet?
      • Is there a firewall blocking inbound SSH?

      Fix the issue and say **Done** to retry, or give me a different address.
```

#### User already has a saved alias

```
User: connect to api-prod
AI:   Connecting to **api-prod** (deploy@api.mycompany.com)... 🔄

      ✅ Connected! What would you like to do?
```

No onboarding, no install command — straight to an active session.

---

## Key Identity Model

Clawdfather uses a **single-key-per-account** model that eliminates all key management UX.

### How It Works

- **One Ed25519 keypair per account**, labeled `"default"` in the `agent_keypairs` table.
- **Auto-generated on first OAuth login.** During the OAuth callback, the server checks if the account has a keypair. If not, it generates one immediately. This is invisible to the user — they never see a "generating your key" step.
- **Never shown as a "key management" concept.** Users don't think in terms of keys. They think "connect to my server." The key is an implementation detail that surfaces only when the install command is displayed during onboarding.
- **Public key surfaced only during onboarding.** The `echo '...' >> ~/.ssh/authorized_keys` command is the only time the user sees key material, and it's presented as an action to take, not a key to manage.

### Key Rotation

Key rotation is available as a chat command for advanced users:

```
User: rotate my key
AI:   ⚠️ This will generate a new SSH key. You'll need to re-install the key
      on each server. Currently connected to 3 servers.

      Are you sure? (yes/no)

User: yes
AI:   🔑 New key generated. Your old key still works on existing servers until
      you update them. To update a server, say "reinstall key on [server name]".
```

Key rotation does not break existing connections immediately — the old authorized_keys entries on servers still reference the old key. The user must re-install the new key on each server at their own pace. New connections automatically use the new key.

### Why Single-Key

Multiple keys per account add complexity without meaningful security benefit in this context. The threat model for Clawdfather is: if the account is compromised, all keys are compromised regardless. A single key simplifies the mental model, eliminates a selection step during onboarding, and keeps the API surface small.

---

## Memory-Driven Alias System

Server aliases are the primary way users refer to their servers. Instead of remembering `deploy@api-us-east-1.prod.mycompany.com:2222`, they say "connect to prod."

### Memory Schema

Each alias is stored as an OpenClaw long-term memory entry:

```json
{
  "type": "server_alias",
  "alias": "prod",
  "display": "Production API Server",
  "user": "deploy",
  "host": "api.mycompany.com",
  "port": 22,
  "connection_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "last_session": "2026-02-21T00:00:00Z"
}
```

| Field | Purpose |
|---|---|
| `type` | Always `"server_alias"` — used to query memory for all aliases |
| `alias` | Short name the user chose (lowercase, normalized) |
| `display` | Optional human-readable description |
| `user` | SSH username |
| `host` | SSH hostname or IP |
| `port` | SSH port (default 22) |
| `connection_id` | Foreign key to `ssh_connections` table |
| `last_session` | Timestamp of last active session (updated on each connect) |

### Alias Resolution

When a user says "connect to X", the AI resolves X through this priority chain:

1. **Exact match** — alias field matches X exactly → use it immediately, skip onboarding
2. **Partial match** — X is a substring of an alias or display name → present options:
   ```
   AI: I found a few matches:
       • **prod** — deploy@api.mycompany.com
       • **prod-staging** — deploy@staging.mycompany.com
       Which one?
   ```
3. **No match** — no alias matches X → treat X as a new server, trigger onboarding flow

### Alias Lifecycle

- **Creation:** After successful onboarding, AI prompts "Want to give this server a name?" User can accept or skip.
- **Update:** "Rename prod to production" → updates the alias field in memory.
- **Deletion:** "Forget prod" → removes the memory entry. The `ssh_connections` record remains (it's inert without the alias mapping).
- **Listing:** "What servers do I have?" → queries all `server_alias` memory entries and lists them.

---

## Session State Machine

The onboarding and session lifecycle follows a deterministic state machine:

```
                        ┌────────────────────────┐
                        │          idle           │
                        │   (no active onboard)   │
                        └───────────┬────────────┘
                                    │ user: "connect to X"
                                    ▼
                    ┌───────────────────────────────┐
                    │        awaiting_host           │
                    │  (AI asked for user@host)      │◄── skipped if user@host
                    └───────────────┬───────────────┘    provided upfront
                                    │ user provides user@host
                                    ▼
                    ┌───────────────────────────────┐
                    │        awaiting_done           │
                    │  (install cmd shown, waiting)  │
                    └───────────────┬───────────────┘
                                    │ user: "done" / "ready"
                                    ▼
                    ┌───────────────────────────────┐
                    │          testing               │
                    │  (background SSH test)         │
                    └──────┬────────────────┬───────┘
                           │ success        │ failure
                           ▼                ▼
              ┌─────────────────┐   ┌──────────────────┐
              │    starting     │   │  awaiting_done    │
              │ POST /sessions  │   │ (show error,      │
              └────────┬────────┘   │  re-show command) │
                       │            └──────────────────┘
                       ▼
              ┌─────────────────┐
              │     active      │◄──── heartbeats via WebSocket
              │  (session live) │
              └────────┬────────┘
                       │ user: "end" / timeout / error
                       ▼
              ┌─────────────────┐
              │     closed      │
              │  (back to idle) │
              └─────────────────┘
```

### State Transitions

| From | Event | To | Side Effects |
|---|---|---|---|
| `idle` | User says "connect to X" | `awaiting_host` or `awaiting_done` | Parse user@host if present; if alias found, jump to `starting` |
| `awaiting_host` | User provides user@host | `awaiting_done` | Call `POST /connections/onboard`, display install command |
| `awaiting_done` | User says "done" | `testing` | Call `POST /connections/:id/test-and-activate` |
| `testing` | SSH test succeeds | `starting` | — |
| `testing` | SSH test fails | `awaiting_done` | Show error, re-display install command |
| `starting` | Session created | `active` | `POST /sessions`, open WebSocket, update `last_session` |
| `active` | User says "end" | `closed` | Close WebSocket, `DELETE /sessions/:id` |
| `active` | Heartbeat timeout | `closed` | Auto-cleanup |
| `closed` | — | `idle` | Ready for next connection |

### Edge Cases

- **User says "done" with no pending onboard:** AI responds "I don't have a pending server setup. Want to connect to a server?"
- **User says "connect to Y" while already connected to X:** AI asks "You're connected to X. Disconnect first?" (single-session model for v1).
- **User goes silent during `awaiting_done`:** State persists. If user returns hours later and says "done," the test still runs. Onboarding state has no timeout — only active sessions have heartbeat timeouts.

---

## UI Layout (Session-First)

### Login Screen

Unchanged from current implementation:

- Clawdfather logo (🦞) centered
- "Sign in with GitHub" OAuth button
- Minimal branding text

### Chat Screen (Primary — Only Screen After Login)

```
┌─────────────────────────────────────┐
│ 🦞 Clawdfather   api-prod  ⊗ End   │  ← Header
├─────────────────────────────────────┤
│                                     │
│  AI: Welcome back! You have 2       │
│  servers saved. Say "connect to     │
│  [name]" or tell me about a new     │
│  server.                            │
│                                     │
│  User: connect to prod              │
│                                     │
│  AI: Connecting to prod             │
│  (deploy@api.mycompany.com)... 🔄   │
│                                     │
│  AI: ✅ Connected! What would you   │
│  like to do?                        │
│                                     │
│  User: show disk usage              │
│                                     │
│  AI: Here's the disk usage:         │
│  /dev/sda1  50G  23G  25G  48% /   │
│                                     │
│                                     │
│                                     │
├─────────────────────────────────────┤
│  [  Type a message...        ] [➤]  │  ← Input bar
└─────────────────────────────────────┘
```

**Header elements:**
- **Left:** Clawdfather logo / back button (if launched from OpenClaw parent app)
- **Center:** Server name when connected, "No active session" when idle
- **Right:** End Session button (only visible when session is active)

**Message thread:**
- Full-height between header and input bar
- Auto-scrolls to bottom on new messages
- Supports code blocks (for command output), inline formatting, and emoji
- AI messages left-aligned, user messages right-aligned

**Input bar:**
- Fixed to bottom, above safe area on iOS
- Text input with auto-resize (up to 4 lines)
- Send button (arrow icon) on the right
- Keyboard pushes the input bar up (not obscured)

**What's NOT here:**
- No bottom tab bar
- No floating action button
- No hamburger menu or side drawer
- No pull-down-to-refresh
- No notification badges

### When No Session Is Active

The AI greets the user and proactively offers next steps:

```
AI: Hey! 👋 What server would you like to work on?

    Your saved servers:
    • **prod** — deploy@api.mycompany.com
    • **staging** — deploy@staging.mycompany.com

    Say a server name to connect, or tell me about a new server.
```

### When Session Is Active

Normal chat with server context injected into the AI's system prompt. The AI can run commands, read files, check status, and perform administrative tasks. The header updates to show the connected server name with a green indicator.

---

## API Changes Required

Only two convenience endpoints are added. All existing endpoints remain unchanged.

### 1. `GET /api/v1/keys/default/install-command`

Returns the install command for the account's default keypair without requiring the caller to know the key ID.

**Response:**
```json
{
  "install_command": "echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample...' >> ~/.ssh/authorized_keys",
  "public_key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample...",
  "key_id": "uuid"
}
```

**Errors:**
- `404` — No default key found (should never happen if auto-generation works)
- `401` — Not authenticated

### 2. `POST /api/v1/connections/onboard`

Combines connection creation with install command generation in a single call. Designed for the AI agent to call during chat-led onboarding.

**Request:**
```json
{
  "user": "deploy",
  "host": "api.mycompany.com",
  "port": 22
}
```

**Response:**
```json
{
  "connection_id": "uuid",
  "install_command": "echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample...' >> ~/.ssh/authorized_keys",
  "user": "deploy",
  "host": "api.mycompany.com",
  "port": 22,
  "created": true
}
```

If a connection with the same `user@host:port` already exists, it returns the existing record with `"created": false` instead of creating a duplicate.

**Errors:**
- `400` — Missing required fields
- `401` — Not authenticated
- `409` — Connection limit reached (if applicable)

### Existing Endpoints (Unchanged)

All of these continue to work exactly as before:

- `GET/POST/DELETE /api/v1/keys/*`
- `GET/POST/DELETE /api/v1/connections/*`
- `GET /api/v1/connections/:id/test`
- `POST/DELETE /api/v1/sessions/*`
- `GET /api/v1/sessions/:id/ws` (WebSocket)
