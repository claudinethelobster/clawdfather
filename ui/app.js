(function () {
  "use strict";

  // ── Configuration ──────────────────────────────────────────────────
  const API = "/api/v1";
  const TOKEN_KEY = "clf_token";
  const VERSION = "0.2.0";

  // ── State ──────────────────────────────────────────────────────────
  let token = localStorage.getItem(TOKEN_KEY);
  let account = null;
  let connections = [];
  let keypairs = [];

  function closeContextMenu() {
    var menu = document.querySelector(".context-menu");
    if (menu) menu.remove();
  }
  let sessions = [];
  let currentView = "sessions";
  let ws = null;
  let wsAuthenticated = false;
  let heartbeatTimer = null;
  let chatTimerInterval = null;
  let chatSessionId = null;
  let chatStartedAt = null;
  let isThinking = false;
  let onboardingState = null;

  // ── DOM References ─────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  const screenAuth = $("screen-auth");
  const appShell = $("app-shell");
  const btnGithubLogin = $("btn-github-login");
  const authError = $("auth-error");
  const headerAccountName = $("header-account-name");
  const headerAvatar = $("header-avatar");
  const bottomNav = $("bottom-nav");

  const viewSessions = $("view-sessions");
  const sessionsLoading = $("sessions-loading");
  const sessionsEmpty = $("sessions-empty");
  const sessionsList = $("sessions-list");
  const fabNewSession = $("fab-new-session");

  const viewSettings = $("view-settings");
  const settingsAvatar = $("settings-avatar");
  const settingsDisplayName = $("settings-display-name");
  const settingsEmail = $("settings-email");
  const settingsVersion = $("settings-version");
  const btnSignOut = $("btn-sign-out");

  const viewChat = $("view-chat");
  const chatConnectionLabel = $("chat-connection-label");
  const chatTimer = $("chat-timer");
  const chatMessages = $("chat-messages");
  const chatInput = $("chat-input");
  const btnChatSend = $("btn-chat-send");
  const btnEndSession = $("btn-end-session");
  const btnCancelOnboarding = $("btn-cancel-onboarding");

  const sheetBackdrop = $("sheet-backdrop");
  const sheet = $("sheet");
  const sheetTitle = $("sheet-title");
  const sheetContent = $("sheet-content");
  const toastContainer = $("toast-container");

  // ── API Helpers ────────────────────────────────────────────────────
  async function api(method, path, body) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = "Bearer " + token;

    const opts = { method, headers, credentials: "include" };
    if (body !== undefined) opts.body = JSON.stringify(body);

    const res = await fetch(API + path, opts);

    if (res.status === 401) {
      logout();
      throw new Error("Session expired");
    }

    const data = await res.json();
    if (!res.ok) {
      const msg = (data.error && data.error.message) || data.message || "Request failed";
      throw Object.assign(new Error(msg), { status: res.status, code: (data.error && data.error.code) || data.code, data });
    }
    return data;
  }

  // ── Toast Notifications ────────────────────────────────────────────
  function showToast(message, type) {
    type = type || "info";
    var el = document.createElement("div");
    el.className = "toast toast-" + type;
    el.textContent = message;
    toastContainer.appendChild(el);
    setTimeout(function () {
      el.classList.add("toast-exit");
      setTimeout(function () { el.remove(); }, 300);
    }, 3000);
  }

  // ── Auth ───────────────────────────────────────────────────────────
  function showAuthScreen() {
    screenAuth.classList.add("active");
    appShell.hidden = true;
    authError.hidden = true;
  }

  function showApp() {
    screenAuth.classList.remove("active");
    appShell.hidden = false;
  }

  function showAuthError(msg) {
    authError.textContent = msg;
    authError.hidden = false;
  }

  function logout() {
    var headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = "Bearer " + token;
    fetch(API + "/auth/session", { method: "DELETE", headers: headers, credentials: "include" }).catch(function () {});
    token = null;
    account = null;
    localStorage.removeItem(TOKEN_KEY);
    disconnectWs();
    showAuthScreen();
  }

  async function startGitHubOAuth() {
    btnGithubLogin.disabled = true;
    try {
      var data = await api("POST", "/auth/oauth/github/start");
      window.location.href = data.authorize_url;
    } catch (err) {
      showAuthError(err.message);
      btnGithubLogin.disabled = false;
    }
  }

  async function handleOAuthCallback(code, state) {
    showAuthScreen();
    window.history.replaceState(null, "", window.location.pathname);
    try {
      var res = await fetch(
        API + "/auth/oauth/github/callback?code=" + encodeURIComponent(code) + "&state=" + encodeURIComponent(state),
        { credentials: "include" }
      );
      if (res.redirected || res.headers.get('content-type') === null || !res.headers.get('content-type').includes('application/json')) {
        await checkCookieSession();
      } else {
        var data = await res.json();
        if (!res.ok) {
          showAuthError((data.error && data.error.message) || data.message || "OAuth callback failed");
          return;
        }
        if (data.token) {
          token = data.token;
          localStorage.setItem(TOKEN_KEY, token);
          account = data.account;
          bootApp();
        } else {
          await checkCookieSession();
        }
      }
    } catch (err) {
      showAuthError(err.message || "OAuth callback failed");
    }
  }

  // ── App Boot ───────────────────────────────────────────────────────
  async function bootApp() {
    showApp();
    settingsVersion.textContent = VERSION;
    try {
      var me = await api("GET", "/auth/me");
      account = me.account;
      renderHeader();
      renderSettings();
    } catch (err) {
      if (err.message !== "Session expired") {
        showToast("Failed to load account: " + err.message, "error");
      }
      return;
    }
    navigate(currentView);
  }

  function renderHeader() {
    if (!account) return;
    headerAccountName.textContent = account.display_name || "";
    var initial = (account.display_name || "?")[0].toUpperCase();
    headerAvatar.textContent = initial;
  }

  // ── Navigation ─────────────────────────────────────────────────────
  window.navigate = function (view) {
    if (view === "connections") view = "sessions";
    currentView = view;

    viewSessions.hidden = view !== "sessions";
    viewSettings.hidden = view !== "settings";
    viewChat.hidden = true;
    viewChat.classList.remove("active-chat");

    bottomNav.hidden = false;
    onboardingState = null;

    document.querySelectorAll(".nav-tab").forEach(function (tab) {
      tab.classList.toggle("active", tab.getAttribute("data-view") === view);
    });

    if (view === "sessions") loadSessions();
    else if (view === "settings") loadSettings();
  };

  // ── Sessions ───────────────────────────────────────────────────────
  async function loadSessions() {
    sessionsLoading.hidden = false;
    sessionsEmpty.hidden = true;
    sessionsList.hidden = true;
    fabNewSession.hidden = true;

    try {
      var data = await api("GET", "/sessions");
      sessions = data.sessions || [];
    } catch (err) {
      sessionsLoading.hidden = true;
      showToast("Failed to load sessions: " + err.message, "error");
      return;
    }

    sessionsLoading.hidden = true;
    if (sessions.length === 0) {
      sessionsEmpty.hidden = false;
    } else {
      sessionsList.hidden = false;
      fabNewSession.hidden = false;
      renderSessions();
    }
  }

  function renderSessions() {
    sessionsList.innerHTML = "";
    sessions.forEach(function (sess) {
      var isActive = sess.status === "active" || sess.status === "pending";
      var pillClass = isActive ? "pill-active" : (sess.status === "error" ? "pill-danger" : "pill-gray");
      var connLabel = (sess.connection && sess.connection.label) || "Unknown";
      var connHost = (sess.connection && sess.connection.host) || "";

      var card = document.createElement("div");
      card.className = "session-card";
      card.innerHTML =
        '<div class="session-card-header">' +
          '<span class="session-card-label">' + esc(connLabel) + '</span>' +
          '<span class="pill ' + pillClass + '">' + esc(sess.status) + '</span>' +
        '</div>' +
        '<div class="session-card-host">' + esc(connHost) + '</div>' +
        '<div class="session-card-footer">' +
          '<span class="card-time">' + (sess.started_at ? timeAgo(sess.started_at) : "") + '</span>' +
          (isActive ? '<button class="btn btn-primary">Open Chat</button>' : '') +
        '</div>';

      if (isActive) {
        card.addEventListener("click", function () {
          openChat(sess);
        });
      } else {
        card.style.cursor = "default";
        card.addEventListener("click", function () {
          showToast(
            sess.status === "error"
              ? "Session ended due to an error. Start a new session."
              : "Session has ended. Start a new session.",
            "info"
          );
        });
      }

      sessionsList.appendChild(card);
    });
  }

  // ── Start Session ──────────────────────────────────────────────────
  async function startSession(connectionId) {
    closeSheet();
    showToast("Starting session...", "info");

    try {
      var data = await api("POST", "/sessions", { connection_id: connectionId });
      showToast("Session started", "success");
      openChat(data.session);
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  // ── Chat View ──────────────────────────────────────────────────────
  function openChat(session) {
    onboardingState = null;
    chatSessionId = session.id;
    chatStartedAt = session.started_at ? new Date(session.started_at) : new Date();

    var label = (session.connection && session.connection.label) || "Session";
    chatConnectionLabel.textContent = label;
    chatMessages.innerHTML = "";
    chatInput.value = "";
    chatInput.disabled = false;
    btnChatSend.disabled = false;
    btnEndSession.hidden = false;
    btnCancelOnboarding.hidden = true;
    chatTimer.textContent = "";

    viewSessions.hidden = true;
    viewSettings.hidden = true;
    viewChat.hidden = false;
    viewChat.style.display = "flex";
    viewChat.classList.add("active-chat");
    bottomNav.hidden = true;

    updateChatTimer();
    chatTimerInterval = setInterval(updateChatTimer, 1000);

    addChatSystemMessage("Connecting to session...");
    connectWs(chatSessionId);
  }

  window.exitChat = function () {
    disconnectWs();
    onboardingState = null;
    viewChat.hidden = true;
    viewChat.style.display = "";
    viewChat.classList.remove("active-chat");
    chatInput.placeholder = "Ask me to manage your server...";
    if (chatTimerInterval) {
      clearInterval(chatTimerInterval);
      chatTimerInterval = null;
    }
    chatSessionId = null;
    navigate(currentView);
  };

  window.endCurrentSession = function () {
    if (!chatSessionId) return;
    openSheet("End Session");
    sheetContent.innerHTML =
      '<p class="confirm-text">End this session? The SSH connection will be closed.</p>' +
      '<div class="confirm-actions">' +
        '<button class="btn btn-secondary" id="end-cancel">Cancel</button>' +
        '<button class="btn btn-danger-text" id="end-confirm">End Session</button>' +
      '</div>';

    $("end-cancel").addEventListener("click", closeSheet);
    $("end-confirm").addEventListener("click", async function () {
      closeSheet();
      try {
        await api("DELETE", "/sessions/" + chatSessionId);
        showToast("Session ended", "success");
        addChatSystemMessage("Session has ended.");
        chatInput.disabled = true;
        btnChatSend.disabled = true;
        setTimeout(exitChat, 1500);
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  };

  function updateChatTimer() {
    if (!chatStartedAt) return;
    var elapsed = Math.floor((Date.now() - chatStartedAt.getTime()) / 1000);
    var h = Math.floor(elapsed / 3600);
    var m = Math.floor((elapsed % 3600) / 60);
    var s = elapsed % 60;
    chatTimer.textContent =
      (h > 0 ? pad(h) + ":" : "") + pad(m) + ":" + pad(s);
  }

  function pad(n) { return n < 10 ? "0" + n : String(n); }

  // ── Chat Messages ──────────────────────────────────────────────────
  function addChatMessage(role, text) {
    var div = document.createElement("div");
    div.className = "chat-msg " + role;

    var header = document.createElement("div");
    header.className = "chat-msg-header";

    var sender = document.createElement("span");
    sender.className = "chat-msg-sender " + role;
    sender.textContent = role === "user" ? "You" : role === "assistant" ? "Clawdfather" : "System";

    var time = document.createElement("span");
    time.className = "chat-msg-time";
    time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    header.appendChild(sender);
    header.appendChild(time);

    var body = document.createElement("div");
    body.className = "chat-msg-body";
    body.innerHTML = renderMarkdown(text);

    body.querySelectorAll("pre").forEach(function (pre) {
      var btn = document.createElement("button");
      btn.className = "copy-btn";
      btn.textContent = "copy";
      btn.style.cssText = "position:absolute;top:6px;right:8px;background:var(--card);border:1px solid var(--border);border-radius:4px;color:var(--text-secondary);font-size:11px;padding:2px 8px;cursor:pointer;";
      btn.onclick = function () {
        var code = pre.querySelector("code");
        navigator.clipboard.writeText(code ? code.textContent : pre.textContent);
        btn.textContent = "copied!";
        setTimeout(function () { btn.textContent = "copy"; }, 1500);
      };
      pre.style.position = "relative";
      pre.appendChild(btn);
    });

    div.appendChild(header);
    div.appendChild(body);
    chatMessages.appendChild(div);
    scrollChat();
  }

  function addChatSystemMessage(text) { addChatMessage("system", text); }

  function showThinking() {
    if (isThinking) return;
    isThinking = true;
    var div = document.createElement("div");
    div.className = "chat-thinking";
    div.id = "thinking-indicator";
    div.innerHTML = '<div class="thinking-dots"><span></span><span></span><span></span></div> Thinking...';
    chatMessages.appendChild(div);
    scrollChat();
  }

  function removeThinking() {
    isThinking = false;
    var el = $("thinking-indicator");
    if (el) el.remove();
  }

  function scrollChat() {
    requestAnimationFrame(function () {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    });
  }

  // ── Chat Input ─────────────────────────────────────────────────────
  window.sendChatMessage = function () {
    var text = chatInput.value.trim();
    if (!text) return;

    if (onboardingState) {
      addChatMessage("user", text);
      chatInput.value = "";
      chatInput.style.height = "auto";
      handleOnboardingMessage(text);
      return;
    }

    if (!wsAuthenticated) return;
    addChatMessage("user", text);
    ws.send(JSON.stringify({ type: "message", text: text }));
    chatInput.value = "";
    chatInput.style.height = "auto";
  };

  chatInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  chatInput.addEventListener("input", function () {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 120) + "px";
  });

  // ── WebSocket ──────────────────────────────────────────────────────
  function connectWs(sessionId) {
    disconnectWs();
    wsAuthenticated = false;

    var proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    var host = window.location.host;
    var wsUrl = proto + "//" + host + "/ws/sessions/" + sessionId;

    ws = new WebSocket(wsUrl);

    ws.onopen = function () {
      ws.send(JSON.stringify({ type: "auth", token: token, session_id: sessionId }));
    };

    ws.onmessage = function (event) {
      try {
        var msg = JSON.parse(event.data);
        handleWsMessage(msg);
      } catch (e) {
        console.error("WS parse error:", e);
      }
    };

    ws.onclose = function (event) {
      wsAuthenticated = false;
      stopHeartbeat();
      if (event.code === 4001 || event.code === 4003 || event.code === 4004) {
        addChatSystemMessage("Session has ended.");
        chatInput.disabled = true;
        btnChatSend.disabled = true;
      } else if (chatSessionId === sessionId) {
        addChatSystemMessage("Disconnected. Attempting to reconnect...");
        setTimeout(function () {
          if (chatSessionId === sessionId) connectWs(sessionId);
        }, 2000);
      }
    };

    ws.onerror = function () {};
  }

  function disconnectWs() {
    stopHeartbeat();
    wsAuthenticated = false;
    if (ws) {
      try { ws.close(); } catch (e) {}
      ws = null;
    }
  }

  function handleWsMessage(msg) {
    switch (msg.type) {
      case "session":
        wsAuthenticated = true;
        removeThinking();
        addChatSystemMessage("Connected" + (msg.connection ? " to " + msg.connection.label : ""));
        startHeartbeat();
        break;

      case "auth_ok":
        wsAuthenticated = true;
        startHeartbeat();
        break;

      case "message":
        removeThinking();
        if (msg.role === "assistant") {
          addChatMessage("assistant", msg.text || "");
        } else if (msg.role === "user") {
          // already shown locally
        } else {
          addChatMessage("system", msg.text || "");
        }
        break;

      case "status":
        if (msg.status === "thinking") showThinking();
        else if (msg.status === "done") removeThinking();
        break;

      case "error":
        removeThinking();
        if (!wsAuthenticated) {
          addChatSystemMessage("Session has ended or is not accessible.");
          chatInput.disabled = true;
          btnChatSend.disabled = true;
        } else {
          addChatSystemMessage("Error: " + (msg.message || "Unknown error"));
        }
        break;

      case "heartbeat_ack":
        break;

      default:
        console.log("Unknown WS message:", msg.type);
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(function () {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "heartbeat" }));
      }
    }, 30000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  // ── Settings ───────────────────────────────────────────────────────
  function loadSettings() {
    renderSettings();
  }

  function renderSettings() {
    if (!account) return;
    settingsDisplayName.textContent = account.display_name || "—";
    settingsEmail.textContent = account.email || "No email";
    settingsVersion.textContent = VERSION;

    var initial = (account.display_name || "?")[0].toUpperCase();
    settingsAvatar.textContent = initial;
  }

  // ── SSH Target Parser ──────────────────────────────────────────────
  function parseSSHTarget(text) {
    if (!text || typeof text !== "string") return null;
    text = text.trim();
    var atIdx = text.indexOf("@");
    if (atIdx < 1) return null;

    var username = text.substring(0, atIdx);
    var rest = text.substring(atIdx + 1);
    if (!rest) return null;

    var port = 22;
    var host = rest;
    var colonIdx = rest.lastIndexOf(":");
    if (colonIdx > 0) {
      var portStr = rest.substring(colonIdx + 1);
      var parsedPort = parseInt(portStr, 10);
      if (!isNaN(parsedPort) && String(parsedPort) === portStr) {
        port = parsedPort;
        host = rest.substring(0, colonIdx);
      }
    }

    if (!/^[a-z_][a-z0-9_-]{0,63}$/.test(username)) return null;
    if (!host) return null;
    if (port < 1 || port > 65535) return null;

    return { username: username, host: host, port: port };
  }

  // ── Onboarding Chat Flow ──────────────────────────────────────────
  window.startOnboardingChat = function () {
    onboardingState = { step: "awaiting_target" };
    chatSessionId = null;
    chatStartedAt = null;

    chatConnectionLabel.textContent = "New Session";
    chatMessages.innerHTML = "";
    chatInput.value = "";
    chatInput.disabled = false;
    chatInput.placeholder = "user@host or user@host:port";
    btnChatSend.disabled = false;
    btnEndSession.hidden = true;
    btnCancelOnboarding.hidden = false;
    chatTimer.textContent = "";

    viewSessions.hidden = true;
    viewSettings.hidden = true;
    viewChat.hidden = false;
    viewChat.style.display = "flex";
    viewChat.classList.add("active-chat");
    bottomNav.hidden = true;

    addChatMessage("assistant",
      "\uD83D\uDC4B Let's get you connected!\n\n" +
      "Enter your SSH target in this format:\n" +
      "  `user@host` or `user@host:port`\n\n" +
      "Examples:\n" +
      "  `root@192.168.1.100`\n" +
      "  `deploy@myserver.com:2222`"
    );
  };

  async function handleOnboardingMessage(text) {
    if (!onboardingState) return;

    if (onboardingState.step === "awaiting_target") {
      var parsed = parseSSHTarget(text);
      if (!parsed) {
        addChatMessage("assistant", "That doesn't look right. Please enter as `user@host` or `user@host:port`.");
        return;
      }

      onboardingState.target = parsed;
      chatInput.disabled = true;
      btnChatSend.disabled = true;
      showThinking();

      try {
        var keyData = await api("POST", "/keys", { label: "default" });
        var keypairId = keyData.keypair.id;
        onboardingState.keypairId = keypairId;

        var connData = await api("POST", "/connections", {
          label: parsed.host,
          host: parsed.host,
          port: parsed.port,
          username: parsed.username,
          keypair_id: keypairId,
        });
        var connId = connData.connection.id;
        onboardingState.connId = connId;

        var installData = await api("GET", "/keys/" + keypairId + "/install-command");
        var command = installData.command;

        removeThinking();

        var target = parsed.username + "@" + parsed.host + (parsed.port !== 22 ? ":" + parsed.port : "");
        var msgHtml = "Got it! To authorize Clawdfather's SSH key on **" + target + "**, run this command on your server:\n\n" +
          "```\n" + command + "\n```\n\n" +
          "Once you've run it, say **done** and I'll test the connection.";

        addChatMessage("assistant", msgHtml);

        onboardingState.step = "awaiting_done";
        onboardingState.installCommand = command;
        chatInput.disabled = false;
        btnChatSend.disabled = false;
        chatInput.placeholder = 'Type "done" when ready...';
      } catch (err) {
        removeThinking();
        addChatMessage("assistant", "Something went wrong: " + esc(err.message) + "\n\nPlease try entering your SSH target again.");
        onboardingState.step = "awaiting_target";
        chatInput.disabled = false;
        btnChatSend.disabled = false;
      }

    } else if (onboardingState.step === "awaiting_done") {
      if (/^done$/i.test(text.trim())) {
        chatInput.disabled = true;
        btnChatSend.disabled = true;
        showThinking();

        try {
          var testResult = await api("POST", "/connections/" + onboardingState.connId + "/test");
          removeThinking();

          if (testResult.result === "ok") {
            addChatMessage("assistant", "\u2705 Connected! Starting your session...");
            showThinking();

            await new Promise(function (r) { setTimeout(r, 1000); });

            var sessionData = await api("POST", "/sessions", { connection_id: onboardingState.connId });
            removeThinking();

            chatInput.placeholder = "Ask me to manage your server...";
            onboardingState = null;
            openChat(sessionData.session);
          } else {
            addChatMessage("assistant",
              "\u274C Connection test failed: " + (testResult.message || "Unknown error") +
              ". Make sure you've run the command above and the server is reachable. Say **done** to try again, or type a new target to start over."
            );
            onboardingState.step = "awaiting_done";
            chatInput.disabled = false;
            btnChatSend.disabled = false;
          }
        } catch (err) {
          removeThinking();
          addChatMessage("assistant",
            "\u274C Connection test failed: " + esc(err.message) +
            ". Make sure you've run the command above and the server is reachable. Say **done** to try again, or type a new target to start over."
          );
          onboardingState.step = "awaiting_done";
          chatInput.disabled = false;
          btnChatSend.disabled = false;
        }
      } else {
        var retarget = parseSSHTarget(text);
        if (retarget) {
          onboardingState.step = "awaiting_target";
          handleOnboardingMessage(text);
        } else {
          addChatMessage("assistant", "I'm waiting for you to run the install command on your server. Say **done** when it's done, or enter a new SSH target to change servers.");
        }
      }
    }
  }

  // ── Sign Out ───────────────────────────────────────────────────────
  btnSignOut.addEventListener("click", function () {
    openSheet("Sign Out");
    sheetContent.innerHTML =
      '<p class="confirm-text">Are you sure you want to sign out?</p>' +
      '<div class="confirm-actions">' +
        '<button class="btn btn-secondary" id="signout-cancel">Cancel</button>' +
        '<button class="btn btn-danger-text" id="signout-confirm">Sign Out</button>' +
      '</div>';

    $("signout-cancel").addEventListener("click", closeSheet);
    $("signout-confirm").addEventListener("click", function () {
      closeSheet();
      logout();
    });
  });

  // ── Bottom Sheet ───────────────────────────────────────────────────
  var sheetGeneration = 0;

  function openSheet(title) {
    sheetGeneration++;
    sheetTitle.textContent = title;
    sheetContent.innerHTML = "";
    sheetBackdrop.hidden = false;
    sheet.hidden = false;
    requestAnimationFrame(function () {
      sheetBackdrop.classList.add("visible");
      sheet.classList.add("visible");
    });
  }

  window.closeSheet = function () {
    sheetGeneration++;
    var gen = sheetGeneration;
    sheetBackdrop.classList.remove("visible");
    sheet.classList.remove("visible");
    setTimeout(function () {
      if (gen !== sheetGeneration) return;
      sheetBackdrop.hidden = true;
      sheet.hidden = true;
      sheetContent.innerHTML = "";
    }, 300);
  };

  sheetBackdrop.addEventListener("click", closeSheet);

  // ── Markdown Renderer ──────────────────────────────────────────────
  function renderMarkdown(text) {
    if (!text) return "";

    var html = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function (_, lang, code) {
      return '<pre><code class="language-' + (lang || "text") + '">' + code.trim() + "</code></pre>";
    });

    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    html = html.replace(/\n/g, "<br>");

    html = html.replace(/<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/g, function (match) {
      return match.replace(/<br>/g, "\n");
    });

    return html;
  }

  // ── Utilities ──────────────────────────────────────────────────────
  function esc(str) {
    if (!str) return "";
    var div = document.createElement("div");
    div.appendChild(document.createTextNode(String(str)));
    return div.innerHTML;
  }

  function timeAgo(dateStr) {
    if (!dateStr) return "";
    var now = Date.now();
    var then = new Date(dateStr).getTime();
    var diff = Math.floor((now - then) / 1000);

    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    return Math.floor(diff / 86400) + "d ago";
  }

  // ── Init ───────────────────────────────────────────────────────────
  async function checkCookieSession() {
    try {
      var res = await fetch(API + "/auth/me", { credentials: "include" });
      if (res.ok) {
        var data = await res.json();
        account = data.account;
        bootApp();
      } else {
        showAuthScreen();
      }
    } catch (err) {
      showAuthScreen();
    }
  }

  function init() {
    var params = new URLSearchParams(window.location.search);
    var code = params.get("code");
    var state = params.get("state");

    if (code && state) {
      handleOAuthCallback(code, state);
      return;
    }

    if (token) {
      bootApp();
    } else {
      checkCookieSession();
    }
  }

  btnGithubLogin.addEventListener("click", startGitHubOAuth);

  init();
})();
