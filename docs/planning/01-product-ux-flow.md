# Product & UX Flow Specification

> Clawdfather — Mobile-First Account-Based SSH Orchestration

---

## 1.1 User Journeys

### Journey 1: First-Time Setup

| Step | Screen / Action | System Behavior |
|------|----------------|-----------------|
| 1 | User opens the Clawdfather app for the first time | App displays splash/onboarding screen with "Sign in with GitHub" button |
| 2 | User taps **"Sign in with GitHub"** | App opens system browser / ASWebAuthenticationSession (iOS) / Chrome Custom Tab (Android) to `POST /api/v1/auth/oauth/github/start` redirect URL |
| 3 | GitHub OAuth consent screen loads | User reviews requested scopes: `read:user`, `user:email` |
| 4 | User authorizes the app on GitHub | GitHub redirects to callback URL with authorization `code` + `state` |
| 5 | Callback handler exchanges code for token | `GET /api/v1/auth/oauth/github/callback` → server validates state cookie, exchanges code for GitHub access token, creates `accounts` + `oauth_identities` rows, generates app session token |
| 6 | App receives session token | Token stored in secure keychain (iOS Keychain / Android Keystore). App navigates to home screen. |
| 7 | Server auto-generates Ed25519 keypair | `POST /api/v1/keys` called automatically with `{ label: "default" }`. Keypair generated server-side, private key encrypted with AES-256-GCM, stored in `agent_keypairs` |
| 8 | Onboarding modal shows public key | User sees their public key fingerprint (SHA-256) with a "Copy Public Key" button. Explanation text: "This key lets Clawdfather connect to your servers on your behalf." |
| 9 | User dismisses modal | Home screen shows empty connections list with prominent "Add your first server" CTA |

**Post-condition:** Account created, keypair provisioned, user on home screen ready to add connections.

---

### Journey 2: Add SSH Connection

| Step | Screen / Action | System Behavior |
|------|----------------|-----------------|
| 1 | User taps **"+"** button (bottom-right FAB or top-right nav button) | "Add Connection" form slides up as a bottom sheet (mobile-friendly, one-thumb reachable) |
| 2 | User fills in form fields | **Label** (required, e.g. "prod-api-1"), **Host** (required, e.g. "192.168.1.100"), **Username** (required, e.g. "deploy"), **Port** (optional, defaults to 22). Keypair selector defaults to "default" keypair |
| 3 | User taps **"Next"** | `POST /api/v1/connections` creates the connection record. Server returns connection ID. Form transitions to "Install Key" step |
| 4 | Install Key screen | Shows two options: **(a)** Copy one-liner command button, **(b)** Share sheet to send command to another device. Command fetched from `GET /api/v1/keys/:id/install-command`. Displays: `echo 'ssh-ed25519 AAAA...' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys` |
| 5 | User runs the install command on their server | User does this externally (terminal, another SSH client, etc.) |
| 6 | User returns to app, taps **"Test Connection"** | `POST /api/v1/connections/:id/test` fires. Spinner shown with "Testing connection..." |
| 7a | **Success**: SSH handshake completes | Host key fingerprint shown for TOFU approval: "Is this your server? Fingerprint: SHA256:abc123...". User taps "Yes, trust this server". Host key pinned in `ssh_connections.host_key_fingerprint`. Connection card shows green checkmark |
| 7b | **Failure**: Connection refused / auth failed | Error card with specific message (see §1.3). User offered "Retry" or "Edit Connection" |
| 8 | Connection saved | User returned to home screen. New connection appears in list with label, host, status indicator |

**Post-condition:** Connection saved, key installed on server, host key pinned, ready for sessions.

---

### Journey 3: Test Connection (Standalone)

| Step | Screen / Action | System Behavior |
|------|----------------|-----------------|
| 1 | User taps on an existing connection card | Connection detail sheet opens with server info, last test result, actions |
| 2 | User taps **"Test"** button | `POST /api/v1/connections/:id/test` fires |
| 3 | Spinner: "Testing connection to deploy@192.168.1.100..." | Server performs SSH handshake using stored keypair |
| 4a | **Success** | Green checkmark animation. Latency shown: "Connected in 142ms". `last_tested_at` and `last_test_result` updated |
| 4b | **Host key changed** | Orange warning: "⚠️ The server's host key has changed. This could indicate a security issue or server reinstall. Old fingerprint: SHA256:xxx... New fingerprint: SHA256:yyy... [Accept New Key] [Cancel]" |
| 4c | **Auth failed** | Red error: "Authentication failed. The server rejected your key. Make sure you ran the install command. [Show Install Command] [Retry]" |
| 4d | **Timeout / unreachable** | Red error: "Could not reach server within 15 seconds. Check that the host is online and port 22 is accessible. [Retry]" |

---

### Journey 4: Start Agent Session

| Step | Screen / Action | System Behavior |
|------|----------------|-----------------|
| 1 | User taps on a tested connection card | Connection detail sheet with "Start Session" button (primary action) |
| 2 | User taps **"Start Session"** | `POST /api/v1/sessions` with `{ connection_id: "..." }` |
| 3 | Loading screen: "Starting agent session..." with animated lobster claw icon | Server: creates `session_lease` → decrypts private key → establishes SSH ControlMaster → spawns OpenClaw agent session → returns session ID + chat URL |
| 4 | Chat interface opens | Full-screen chat view. Header shows: connection label, host, session timer. Agent sends initial greeting: "Connected to deploy@192.168.1.100. How can I help you administer this server?" |
| 5 | User sends messages | Messages routed through WebSocket → OpenClaw agent → SSH exec via ControlMaster → response streamed back |
| 6 | User taps **"End Session"** (top-right) or swipes back | Confirmation dialog: "End this session? The SSH connection will be closed." On confirm: `DELETE /api/v1/sessions/:id` → ControlMaster torn down → session_lease marked closed |

**Post-condition:** Agent session active, user chatting with AI that can execute commands on their server.

---

### Journey 5: Reconnect Session

| Step | Screen / Action | System Behavior |
|------|----------------|-----------------|
| 1a | **App returns to foreground** | App checks `GET /api/v1/sessions?status=active` for any active sessions |
| 1b | **User opens app fresh** | Same check on launch |
| 2a | Active session found, still alive | WebSocket re-established to existing session. Chat view restored with message: "Reconnected to session." Previous messages loaded from local cache |
| 2b | Active session found, but expired (heartbeat >5min ago) | Session card shows "Session expired". User prompted: "Your session has ended due to inactivity. [Start New Session]" |
| 2c | No active sessions | Normal home screen with connection list |
| 3 | If reconnect fails (server restarted, etc.) | Error: "Could not reconnect. The session is no longer available. [Start New Session] [Go Home]" |

**Grace period:** After app backgrounds, server keeps ControlMaster alive for 5 minutes past last heartbeat before teardown. WebSocket reconnect is attempted automatically every 5 seconds for up to 60 seconds.

---

### Journey 6: Remove Connection

| Step | Screen / Action | System Behavior |
|------|----------------|-----------------|
| 1 | User long-presses a connection card (or taps "..." menu) | Context menu appears: "Edit", "Test", **"Remove"** (red) |
| 2 | User taps **"Remove"** | Confirmation dialog: "Remove 'prod-api-1'? This will delete the saved connection. The SSH key on the server will not be automatically removed." |
| 3 | User confirms | `DELETE /api/v1/connections/:id` fires |
| 4a | No active session on this connection | Connection soft-deleted (`deleted_at` set). Removed from UI with swipe-away animation. Audit log entry created |
| 4b | Active session exists | Error: "Cannot remove this connection while a session is active. End the session first." Dialog stays open with [End Session & Remove] and [Cancel] options |
| 5 | (Optional) Key revocation attempt | If server is reachable, system attempts to remove the public key from `~/.ssh/authorized_keys` on the remote host. This is best-effort — user is informed: "For security, also remove the key from your server manually." |

---

## 1.2 Mobile-First UX Constraints

### Screen Size & Touch Targets

- **Minimum touch target:** 44×44 points (Apple HIG) / 48×48dp (Material Design). All buttons, cards, and interactive elements meet this minimum.
- **Bottom sheet pattern:** All forms and detail views use bottom sheets that slide up from the bottom. This keeps primary actions within thumb reach on large phones.
- **Connection list:** Each connection card is a full-width row (minimum height 72dp) with label, host, status icon. Tapping opens detail, long-press opens context menu.
- **Navigation:** Tab bar at bottom with 3 tabs: **Connections** (home), **Sessions** (active/recent), **Settings** (account/keys).
- **No horizontal scrolling.** All content fits within viewport width.

### Avoiding Copy-Paste Pain

The install command (`echo 'ssh-ed25519 ...' >> ~/.ssh/authorized_keys`) is too long for mobile copy-paste. Solutions:

1. **Share sheet:** Tap "Share Install Command" → system share sheet → send to desktop via AirDrop, email, messaging app, or clipboard manager.
2. **QR code:** Tap "Show QR Code" → displays QR code encoding the install command. User scans with their desktop/terminal.
3. **Short URL:** Generate a one-time-use short URL (e.g., `https://claw.df/install/abc123`) that serves the command as plaintext. Expires after 10 minutes or first access. HTTPS only.
4. **Email to self:** Tap "Email Install Command" → pre-filled email with the command and instructions.

### Biometric Lock

- App access gated behind biometric authentication (Face ID, Touch ID, fingerprint) when available.
- Biometric prompt on app launch and after 5 minutes of inactivity.
- Fallback: device passcode.
- Setting: users can disable biometric lock in Settings (with warning about security implications).
- Biometric is not required for the initial OAuth flow (user hasn't set it up yet).

### App Lifecycle & Session State

| App State | Behavior |
|-----------|----------|
| **Active (foreground)** | WebSocket connected. Heartbeats every 30s. Full interactivity. |
| **Background (recent)** | WebSocket disconnected after 10s. Server continues ControlMaster. Session lease heartbeat paused. |
| **Background (>5 min)** | Server begins grace period countdown. After 5 min with no heartbeat → ControlMaster teardown, session_lease marked closed. |
| **Killed / force-quit** | Same as >5 min background. Session cleaned up server-side. |
| **Foreground resume** | App immediately attempts WebSocket reconnect. If session still alive, resumes. If expired, shows "Session expired" message. |

### Push Notifications (Phase 2)

- **Session about to expire:** "Your session on prod-api-1 will expire in 5 minutes due to inactivity. Tap to reconnect."
- **Session ended:** "Your session on prod-api-1 has ended."
- **Connection test result (background):** "Connection test for prod-api-1: Success ✓"
- **Security alert:** "A new login to your Clawdfather account was detected from [device/IP]."

### Actionable Error Messages

Every error message follows this pattern:

1. **What happened** (clear, non-technical summary)
2. **Why it might have happened** (likely cause)
3. **What to do** (specific action with a button)

**Never:** "Error occurred", "Something went wrong", "Unknown error", "Error code 500".

---

## 1.3 Error & Edge-Case Flows

### OAuth Failures

| Scenario | User Sees | Recovery |
|----------|-----------|----------|
| **User denies OAuth consent** | "You declined to sign in with GitHub. Clawdfather needs GitHub access to create your account." | [Try Again] button returns to sign-in screen |
| **GitHub OAuth service down** | "GitHub is temporarily unavailable. Please try again in a few minutes." | [Retry] button. Automatic retry after 30s (max 3 attempts) |
| **State parameter mismatch (CSRF)** | "Sign-in session expired. Please try again." | [Sign In Again] restarts OAuth flow |
| **OAuth token expired during use** | Silent refresh attempted first. If refresh fails: "Your GitHub session has expired. Please sign in again." | [Re-authenticate] → OAuth flow with existing account link |
| **Account already linked to another provider** | "This GitHub account is already linked to a different Clawdfather account. Sign in with that account instead." | [Sign In] with original account |

### Keypair Generation Failures

| Scenario | User Sees | Recovery |
|----------|-----------|----------|
| **Crypto subsystem failure** | "Failed to generate your security key. This is a server-side issue." | [Retry] button. Alert sent to ops team automatically |
| **Account at key limit (5 active keys)** | "You've reached the maximum number of active keys. Revoke an unused key first." | [Manage Keys] → Settings → Keys screen |
| **Key storage failure (DB error)** | "Failed to save your security key. Please try again." | [Retry]. If persistent, "Contact support" link |

### SSH Connection Failures

| Scenario | User Sees | Recovery |
|----------|-----------|----------|
| **Host unreachable** | "Cannot reach [host]. The server may be offline or the hostname may be incorrect." | [Edit Connection] to fix host, [Retry] |
| **Connection refused (port closed)** | "Connection to [host]:22 was refused. SSH may not be running on this port." | [Edit Connection] to change port, instructions to check sshd |
| **Authentication failed** | "The server rejected your key. Make sure you ran the install command on the server." | [Show Install Command], [Retry] |
| **Host key changed** | "⚠️ Security Warning: The server's identity has changed since your last connection. This could mean the server was reinstalled, or someone may be intercepting your connection." | [Accept New Key] (re-pins), [Reject & Disconnect] |
| **Host key mismatch (409 response)** | Same as above, with old vs. new fingerprint comparison table | [Accept New Key] sends `{ accept_host_key: true }`, [Reject] |
| **Connection timeout (>15s)** | "Connection timed out after 15 seconds. The server may be behind a firewall or experiencing high load." | [Retry], [Edit Connection] |
| **DNS resolution failure** | "Cannot resolve hostname '[host]'. Check the hostname for typos." | [Edit Connection] |

### Session Failures

| Scenario | User Sees | Recovery |
|----------|-----------|----------|
| **Session timeout (idle >30 min)** | "Session expired due to inactivity (30 min idle limit)." | [Start New Session] |
| **Server crash mid-session** | "Lost connection to the server. The SSH session was interrupted." | [Reconnect] (attempts new ControlMaster), [Close Session] |
| **ControlMaster process killed** | Same as server crash | Same recovery |
| **Agent runtime error** | "The AI agent encountered an error. Your SSH connection is still active." | [Retry Last Message], [End Session] |
| **Concurrent session limit hit** | "You've reached your active session limit (3). Close an existing session to start a new one." | [View Active Sessions] → can close from list |
| **WebSocket disconnect** | "Connection interrupted. Reconnecting..." (auto-retry) | Automatic reconnect with exponential backoff (1s, 2s, 4s, 8s, max 30s). After 60s: "Unable to reconnect. [Retry Manually]" |

### Key Lifecycle Errors

| Scenario | User Sees | Recovery |
|----------|-----------|----------|
| **Revoked key used for connection** | "This key has been revoked. Generate a new key and install it on your server." | [Generate New Key] → install flow |
| **Key rotation in progress** | "Key rotation is in progress. Please wait for it to complete before starting a session." | Polling with spinner, auto-continues when complete |
| **Deleted key referenced by connection** | Connection shows warning badge: "Key no longer valid. Update this connection's key." | [Select New Key] on connection edit |

### Network Loss

| Scenario | User Sees | Recovery |
|----------|-----------|----------|
| **Network loss during OAuth** | "No internet connection. Check your network and try again." | [Retry] when connectivity returns |
| **Network loss during active session** | "Connection lost. Reconnecting when network is available..." | Auto-reconnect on network change event. ControlMaster stays alive server-side for grace period |
| **Network loss during connection test** | "Network error during test. Check your connection and try again." | [Retry] |

### Rate Limit Errors

| Scenario | User Sees | Recovery |
|----------|-----------|----------|
| **OAuth start rate limit (10/min)** | "Too many sign-in attempts. Please wait [N] seconds." | Countdown timer, button re-enables when limit resets |
| **Connection test rate limit (5/min)** | "You've tested this connection too many times recently. Wait [N] seconds before trying again." | Countdown timer |
| **Session start rate limit (10/hr)** | "You've started too many sessions recently. Please wait before starting another." | Timer showing when limit resets |
