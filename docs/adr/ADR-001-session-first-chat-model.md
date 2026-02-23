# ADR-001: Session-First Chat-Centric UX Model

**Status:** Accepted  
**Date:** 2026-02-21  
**Deciders:** Clawdfather core team  

---

## Context

The original Clawdfather mobile design (PR #5) followed a traditional CRUD-based approach with three separate tabs:

- **Connections tab** — form-based creation and management of SSH connections (user@host, port, key selection)
- **Keys tab** — keypair generation, listing, deletion, and install-command display
- **Sessions tab** — list of active and historical SSH sessions

While functionally complete, this design introduced significant UX friction on mobile:

1. **Copy-paste pain.** Users had to copy long `echo 'ssh-ed25519 ...' >> ~/.ssh/authorized_keys` commands from one tab, switch to a terminal app, paste, switch back, and then manually trigger a connection test. On mobile, app-switching and clipboard management is error-prone.

2. **Cognitive overhead.** Users had to understand the relationship between keys, connections, and sessions — three distinct concepts — before they could accomplish their actual goal: "talk to my server via AI."

3. **Redundant navigation.** Setting up a single server required visiting the Keys tab (generate/select key), the Connections tab (create connection, fill form, test), and finally the Sessions tab (start session). That's three screens for one intent.

4. **Misaligned with user intent.** The core value proposition of Clawdfather is AI-powered server administration through natural conversation. The user's mental model is "I want to chat with my server," not "I want to manage a database of connection records."

5. **Chat-native ecosystem.** Users interact with Clawdfather primarily through chat platforms (Telegram, WhatsApp, etc.) in the OpenClaw ecosystem. A form-based UI feels foreign in this context — chat is the native medium.

## Decision

Adopt a **session-first, chat-centric model** where all server setup, key management, and connection handling happens through natural language conversation. The guiding principle: **the chat IS the interface.**

### Key Tenets

1. **One screen: chat.** There are no separate Connections, Keys, or Settings tabs. After login, the user sees a chat thread and nothing else. Every operation — connecting to a server, naming it, checking status, ending a session — happens through messages.

2. **One key per account.** A single Ed25519 keypair is generated automatically on first login and reused for all connections. There is no key selection UI, no key list, and no manual key generation. Key rotation is an admin-level operation performed via chat command (`"rotate my key"`), not a settings screen.

3. **Chat-led SSH onboarding.** When a user wants to connect to a new server, they express their intent naturally — "connect to deploy@api.mycompany.com" or "set up my prod server." The AI handles the entire flow:
   - a. Parse the user's message for `user@host`, or ask for it if not provided
   - b. Generate and display the install command: `echo 'ssh-ed25519 AAAA...' >> ~/.ssh/authorized_keys`
   - c. Tell the user: "Run this on your server, then say **Done** when ready."
   - d. Wait for the user to confirm ("Done", "ready", "installed it", etc.)
   - e. Test the connection silently in the background
   - f. On success: "✅ Connected! I can now run commands on api.mycompany.com."
   - g. On failure: show a specific error with actionable next steps

4. **Memory-driven alias handling.** The AI uses OpenClaw memory to map human-friendly names to `user@host` entries. "My prod server" resolves to `deploy@prod.mycompany.com`. Aliases are established through conversation ("call it prod") and persist across sessions via long-term memory.

5. **Implicit connection records.** When a connection is successfully established through chat onboarding, a record is saved to `ssh_connections` automatically — no form required. The user never interacts with or sees the database record directly.

## Consequences

### Positive

- **Near-zero onboarding friction.** Users only need to run one command on their server. Everything else is conversational.
- **Works identically on mobile and desktop.** Pure chat interface requires no responsive layout, no mobile-specific nav, no breakpoint handling.
- **Dramatically reduced UI surface.** Fewer screens means fewer bugs, less maintenance, and faster iteration.
- **Natural language is more accessible.** Users who struggle with forms or technical UI can simply describe what they want in plain English.

### Neutral

- **Backend tables remain unchanged.** The `ssh_connections`, `agent_keypairs`, and `session_leases` tables still exist and are populated — they're just not directly exposed to users through a dedicated UI. This means no database migration is needed.

### Negative

- **Power users lose direct key management UI.** There is no screen to view all keys, revoke specific keys, or manage key metadata. **Mitigated:** These operations are available via chat commands (e.g., "rotate my key", "show my public key", "revoke my key for server X").
- **Session list is not visible as a tab.** Users cannot glance at all active sessions at once. **Mitigated:** The active session is always shown in the chat header; users can ask "what sessions do I have?" to get a list.

## Comparison Table

| Aspect | Original Model (PR #5) | Session-First Model |
|---|---|---|
| **UX entry point** | Tab-based navigation (Connections, Sessions, Keys) | Single chat screen — all interactions via messages |
| **Key management** | Dedicated Keys tab with generate/delete/list UI | One auto-generated key per account; managed via chat commands |
| **Connection management** | Form-based CRUD in Connections tab (user, host, port, key dropdown) | AI parses intent from chat; connection records created implicitly on successful onboarding |
| **Onboarding steps** | 1) Generate key 2) Copy install cmd 3) SSH to server & paste 4) Create connection form 5) Test 6) Start session | 1) Say "connect to X" 2) Run install cmd on server 3) Say "Done" |
| **Mobile navigation** | Bottom nav with 3+ tabs, bottom sheet forms, FAB buttons | No nav bar — single chat view with minimal header |
| **Session management** | Dedicated Sessions tab with list view | Active session shown in header; ask AI for list or to end session |
| **Alias support** | None — connections identified by user@host in a list | Memory-driven aliases set through conversation ("call it prod") |

## Implementation Notes

### Key Identity

A single `agent_keypairs` row per account with label `"default"` is auto-generated on first OAuth login. The generation happens server-side during the OAuth callback flow. There is no UI for key creation — it's invisible to the user.

### Connection Records

Connection records in `ssh_connections` are created automatically when chat-led onboarding succeeds (i.e., the background SSH test passes). The AI agent calls `POST /api/v1/connections/onboard` with the parsed `user`, `host`, and optional `port`. No form submission is involved.

### Install Command Endpoint

The existing `GET /api/v1/keys/:id/install-command` endpoint is called by the AI agent during chat onboarding — not rendered in a UI panel. A convenience endpoint `GET /api/v1/keys/default/install-command` will be added so the agent doesn't need to look up the key ID.

### Memory Integration

The AI stores connection metadata in OpenClaw memory:

```json
{
  "type": "server_alias",
  "alias": "prod",
  "user": "deploy",
  "host": "api.mycompany.com",
  "port": 22,
  "connection_id": "uuid"
}
```

This is stored in both session memory (for the current conversation) and long-term memory (for cross-session persistence). Alias resolution follows: exact match → use it; partial match → present options; no match → trigger onboarding.

### Web UI Simplification

The web UI reduces to a single chat view:

- **Header:** Clawdfather logo, current server name (or "No active session"), end-session button
- **Body:** Full-height scrollable message thread
- **Footer:** Text input with send button, safe-area aware on mobile
- **No bottom nav tabs, no floating action buttons, no side drawer**

The OAuth login screen remains unchanged.
