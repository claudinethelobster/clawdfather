# Migration Guide: From Connections/Keys UI to Session-First Chat Model

This document describes the incremental migration from the current 3-tab mobile UI (PR #5 baseline) to the session-first, chat-centric model defined in [ADR-001](../adr/ADR-001-session-first-chat-model.md).

---

## Current Implementation (PR #5 Baseline)

The current Clawdfather mobile UI presents three primary tabs via bottom navigation:

1. **Connections tab** — Lists saved SSH connections. A floating action button opens a bottom sheet form where users enter `user`, `host`, `port`, and select a keypair from a dropdown. After creation, users can test the connection and start a session.

2. **Sessions tab** — Lists active and historical SSH sessions. Each entry shows the connection target, status (active/closed), and timestamps. Tapping an active session opens the chat view for that session.

3. **Settings / Keys tab** — Displays the user's SSH keypairs. Users can generate new Ed25519 keys, view public keys, copy install commands, and delete keys. A "copy install command" button provides the `echo '...' >> ~/.ssh/authorized_keys` string.

### Backend Already Supports Session-First

Critically, the **backend APIs and database schema already support everything the session-first model needs**. The REST endpoints for keypairs (`/api/v1/keys/*`), connections (`/api/v1/connections/*`), and sessions (`/api/v1/sessions/*`) remain unchanged. The migration is purely about:

- **Which code calls those endpoints** (AI agent instead of UI forms)
- **What the user sees** (chat instead of tabs and forms)
- **How intent is captured** (natural language instead of form fields)

---

## What Changes

### Backend: No Changes Needed

All existing REST endpoints remain as-is. The database tables — `agent_keypairs`, `ssh_connections`, `session_leases` — are unchanged. No schema migration is required.

The backend continues to:
- Store one or more keypairs per account in `agent_keypairs`
- Store connection records (user, host, port, key reference) in `ssh_connections`
- Manage session lifecycle (create, heartbeat, close) via `session_leases`
- Serve install commands via `GET /api/v1/keys/:id/install-command`

Two **convenience endpoints** are added (non-breaking additions):
- `GET /api/v1/keys/default/install-command` — resolves the account's default key automatically
- `POST /api/v1/connections/onboard` — combines connection creation + install command generation in one call

### UI: Simplified Dramatically

| Removed | Replaced With |
|---|---|
| 3-tab bottom navigation (Connections, Sessions, Settings) | Single chat view — no nav bar |
| Bottom sheet form for adding connections (user, host, port, key dropdown) | AI asks for user@host in chat and parses the response |
| Keys management screen (generate, list, delete, copy install command) | One auto-generated key; install command shown in chat during onboarding |
| Sessions list tab | Active session shown in chat header; "what sessions do I have?" via chat |
| Floating action button (FAB) for "new connection" | User says "connect to X" in chat |

The only UI screens that remain:
- **OAuth login screen** — unchanged (GitHub OAuth button + Clawdfather branding)
- **Chat screen** — header (server name + end session button), message thread, text input

### AI Behavior: New Chat-Driven Flows

The inbound message handler (`src/inbound.ts`) gains new intent recognition capabilities:

| Intent | Trigger Phrases | AI Behavior |
|---|---|---|
| `connect_server` | "connect to X", "set up X", "ssh into X", "add server X" | Parse user@host or ask for it, then begin onboarding flow |
| `confirm_done` | "done", "installed", "ready", "I ran it", "it's installed" | Test the pending connection, report result |
| `assign_alias` | "call it X", "name it X", "that's my X server" | Save alias to OpenClaw memory, confirm to user |
| `list_sessions` | "what sessions do I have", "show active sessions", "my servers" | Query active sessions, list them in chat |
| `end_session` | "disconnect", "end session", "stop", "close" | Close the active session, confirm |

---

## Phased Rollout from Current State

### Phase A — Backend Hardening (~1 week)

**Goal:** Ensure the backend is rock-solid for AI-driven flows. No UI changes.

**Tasks:**

1. **Auto-keypair on signup.** Verify that when a new account is created via OAuth, an Ed25519 keypair (label: `"default"`) is generated immediately. The current implementation partially does this — audit the OAuth callback handler and harden it to guarantee exactly one default key per account, with retry logic if key generation fails.

2. **Default key install-command shortcut.** Add `GET /api/v1/keys/default/install-command`. This endpoint resolves the account's default keypair (by label) and returns the install command text. No key ID required. Returns `404` if no default key exists.

3. **Chat-onboard endpoint.** Add `POST /api/v1/connections/onboard` accepting `{ user: string, host: string, port?: number }`. This endpoint:
   - Creates a new `ssh_connections` record linked to the account's default key
   - Generates and returns the install command text
   - Returns `{ connection_id, install_command }` in one response
   - Idempotent: if a connection with the same user@host already exists, returns the existing record

4. **Test-and-activate endpoint.** Add `POST /api/v1/connections/:id/test-and-activate`. This endpoint:
   - Initiates an SSH connection test to the saved host
   - On success: sets `last_test_result = 'ok'` and `last_tested_at = now()`
   - Returns the test result with error details on failure

**Acceptance Criteria:**
- [ ] New account via OAuth always has exactly one default keypair within 1 second of creation
- [ ] `GET /api/v1/keys/default/install-command` returns correct install command without needing key ID
- [ ] `POST /api/v1/connections/onboard` creates connection + returns install command in one call
- [ ] `POST /api/v1/connections/:id/test-and-activate` correctly tests SSH and updates the record

### Phase B — Chat Agent Intent Handling (~1 week)

**Goal:** The AI can guide a user through full server onboarding via chat.

**Tasks:**

1. **Intent recognition.** In `src/inbound.ts` (or a new `src/intents/` directory), implement intent classification for the five intents listed above: `connect_server`, `confirm_done`, `assign_alias`, `list_sessions`, `end_session`.

2. **Onboarding state machine.** Implement a per-conversation state machine with states:
   - `idle` — no onboarding in progress
   - `awaiting_host` — AI asked for user@host, waiting for response
   - `awaiting_done` — install command shown, waiting for user to confirm
   - `testing` — background SSH test in progress
   - `connected` — session active

   State is stored in the conversation/session context so it persists across messages within the same conversation.

3. **Error handling.** Implement specific error messages for common failure modes:
   - Auth failure → "The key wasn't accepted. Make sure you ran the install command as the correct user. Here it is again: ..."
   - Timeout → "Couldn't reach the server. Check that SSH (port 22) is open and the hostname is correct."
   - DNS failure → "Couldn't resolve that hostname. Double-check the address."

4. **Existing connection shortcut.** If user says "connect to X" and X matches a known alias or existing connection, skip onboarding and go straight to session creation.

**Acceptance Criteria:**
- [ ] User can go from "connect to deploy@host" to an active session entirely via chat messages
- [ ] Connection test failures show specific, actionable error messages
- [ ] Existing connections are reused without re-onboarding
- [ ] State machine correctly handles out-of-order messages (e.g., user says "done" with no pending onboard)

### Phase C — UI Simplification (~1 week)

**Goal:** The mobile web UI is a single chat screen with no tab navigation.

**Tasks:**

1. **Replace the 3-tab layout** in `ui/index.html` with a single-page chat view.

2. **Chat screen layout:**
   - Header: `[🦞 Clawdfather] [server name or "No active session"] [⊗ End]`
   - Body: full-height scrollable message thread
   - Footer: text input + send button, respecting mobile safe areas (`env(safe-area-inset-bottom)`)

3. **Remove all connection/key management UI:** bottom sheet forms, key list views, connection list views, FAB buttons.

4. **Keep the OAuth login screen** exactly as-is.

5. **Settings via header icon:** A small gear icon in the header opens a minimal settings panel (or settings are handled entirely via chat).

**Acceptance Criteria:**
- [ ] After login, user sees only the chat screen — no tabs, no navigation drawer
- [ ] Active session server name is visible in the header at all times
- [ ] End Session button closes the session and returns to idle chat state
- [ ] UI works correctly on iOS Safari and Android Chrome (viewport, safe areas, keyboard handling)

### Phase D — Memory Integration (~1 week)

**Goal:** Server aliases persist across sessions via OpenClaw long-term memory.

**Tasks:**

1. **Store aliases on creation.** When a user names a server ("call it prod"), store the alias in OpenClaw long-term memory:
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

2. **Pre-load aliases on session start.** When a new conversation begins, query long-term memory for all `server_alias` entries and inject them into the system context so the AI knows about existing servers.

3. **Alias resolution logic:**
   - Exact match → use it immediately, skip onboarding
   - Partial/fuzzy match → "Did you mean **prod** (deploy@api.mycompany.com)?"
   - No match → trigger onboarding flow

4. **Alias update and deletion.** Support "rename prod to production" and "forget prod" via chat.

**Acceptance Criteria:**
- [ ] Aliases survive across completely new chat sessions (long-term memory persistence)
- [ ] "Connect to prod" resolves to the correct connection without re-onboarding
- [ ] Ambiguous alias matches present the user with options
- [ ] Users can rename and delete aliases via chat

---

## Rollback Plan

Since the backend is unchanged throughout this migration, rollback is straightforward:

1. **Phase A/B rollback:** No UI impact. Remove new endpoints if needed; existing endpoints are untouched.
2. **Phase C rollback:** Restore the previous `ui/index.html` and `ui/app.js` from git. No database changes to revert.
3. **Phase D rollback:** Memory entries are additive; they can be ignored or cleaned up without affecting core functionality.

**Before starting Phase C**, git-tag the last known-good UI state:

```bash
git tag pre-session-first-ui
```

This provides an instant rollback target for the UI layer.

---

## Summary

This migration reshapes the user experience without touching the data layer. The backend remains a stable foundation while the frontend collapses from a multi-screen app into a single chat view, and the AI agent takes over the responsibilities previously handled by forms and navigation. Each phase is independently deployable and reversible.
