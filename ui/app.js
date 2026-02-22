/**
 * Clawdfather — Session-First Chat UI
 *
 * State machine:
 *   AUTH → LOADING → GREETING → COLLECT_TARGET → PROBING →
 *     → NEEDS_INSTALL → CONFIRMING → STARTING → ACTIVE_SESSION
 *     → BLOCKED → COLLECT_TARGET (retry)
 *     → SESSION_ENDED → GREETING
 */

var STATES = {
  AUTH: 'AUTH',
  LOADING: 'LOADING',
  GREETING: 'GREETING',
  COLLECT_TARGET: 'COLLECT_TARGET',
  PROBING: 'PROBING',
  NEEDS_INSTALL: 'NEEDS_INSTALL',
  BLOCKED: 'BLOCKED',
  CONFIRMING: 'CONFIRMING',
  STARTING: 'STARTING',
  ACTIVE_SESSION: 'ACTIVE_SESSION',
  SESSION_ENDED: 'SESSION_ENDED',
};

var app = {
  state: STATES.AUTH,
  account: null,
  sessionId: null,
  connectionId: null,
  targetHost: null,
  targetUser: null,
  targetPort: null,
  ws: null,
  _menuOverlay: null,

  // ── DOM refs ───────────────────────────────────────────────────
  $: {
    screenAuth: () => document.getElementById('screen-auth'),
    screenChat: () => document.getElementById('screen-chat'),
    authError: () => document.getElementById('auth-error'),
    thread: () => document.getElementById('chat-thread'),
    input: () => document.getElementById('chat-input'),
    btnSend: () => document.getElementById('btn-send'),
    btnEnd: () => document.getElementById('btn-end-session'),
    btnAvatar: () => document.getElementById('btn-user-menu'),
    sessionIndicator: () => document.getElementById('session-indicator'),
    accountMenu: () => document.getElementById('account-menu'),
    menuAvatar: () => document.getElementById('menu-avatar'),
    menuName: () => document.getElementById('menu-name'),
    menuLogin: () => document.getElementById('menu-login'),
  },

  // ── Init ───────────────────────────────────────────────────────

  async init() {
    this.bindInput();
    this.setState(STATES.LOADING);

    const params = new URLSearchParams(window.location.search);
    if (params.get('session_established')) {
      window.history.replaceState(null, '', window.location.pathname);
    }

    await this.checkAuth();
  },

  bindInput() {
    const input = this.$.input();
    const btnSend = this.$.btnSend();

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.onSend();
      }
    });

    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });

    btnSend.addEventListener('click', () => this.onSend());
  },

  onSend() {
    const input = this.$.input();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    this.sendMessage(text);
  },

  // ── Auth ───────────────────────────────────────────────────────

  async checkAuth() {
    try {
      const res = await this.api('GET', '/api/v1/auth/me');
      if (res.ok) {
        this.account = res.data.account;
        this.showChatScreen();
        await this.tryRestoreSession();
        if (this.state !== STATES.ACTIVE_SESSION) {
          this.setState(STATES.GREETING);
          this.greetUser();
        }
        return;
      }
    } catch {}
    this.setState(STATES.AUTH);
    this.$.screenAuth().hidden = false;
    this.$.screenChat().hidden = true;
  },

  login() {
    window.location.href = '/api/v1/auth/oauth/github/start';
  },

  async logout() {
    this.closeMenu();
    try {
      await this.api('DELETE', '/api/v1/auth/session');
    } catch {}
    this.account = null;
    this.sessionId = null;
    this.connectionId = null;
    if (this.ws) { this.ws.close(); this.ws = null; }
    this.$.screenChat().hidden = true;
    this.$.screenAuth().hidden = false;
    this.setState(STATES.AUTH);
  },

  // ── Screen management ──────────────────────────────────────────

  showChatScreen() {
    this.$.screenAuth().hidden = true;
    this.$.screenChat().hidden = false;
    if (this.account) {
      const avatar = this.$.btnAvatar();
      if (this.account.avatar_url) {
        avatar.style.backgroundImage = 'url(' + this.account.avatar_url + ')';
      }
    }
  },

  // ── State machine ──────────────────────────────────────────────

  setState(newState) {
    this.state = newState;
    const input = this.$.input();
    const btnSend = this.$.btnSend();
    const btnEnd = this.$.btnEnd();

    var inputActive = [STATES.GREETING, STATES.COLLECT_TARGET, STATES.NEEDS_INSTALL, STATES.BLOCKED, STATES.ACTIVE_SESSION, STATES.SESSION_ENDED].indexOf(newState) !== -1;
    input.disabled = !inputActive;
    btnSend.disabled = !inputActive;

    if (inputActive && newState !== STATES.SESSION_ENDED) {
      input.focus();
    }

    btnEnd.hidden = newState !== STATES.ACTIVE_SESSION;
    this.updateSessionIndicator();
  },

  updateSessionIndicator() {
    const el = this.$.sessionIndicator();
    if (this.state === STATES.ACTIVE_SESSION && this.targetHost) {
      var portSuffix = this.targetPort && this.targetPort !== 22 ? ':' + this.targetPort : '';
      el.textContent = this.targetUser + '@' + this.targetHost + portSuffix + ' \u2022 Connected';
      el.classList.add('active');
    } else if (this.state === STATES.PROBING || this.state === STATES.CONFIRMING || this.state === STATES.STARTING) {
      el.textContent = 'Connecting...';
      el.classList.remove('active');
    } else {
      el.textContent = 'No active session';
      el.classList.remove('active');
    }
  },

  // ── Greeting ───────────────────────────────────────────────────

  greetUser() {
    const name = this.account?.display_name || this.account?.login || 'there';
    this.addMessage('agent',
      '👋 Hi ' + name + "! I'm Clawdfather — your AI server admin.\n\n" +
      "Which server would you like to manage?\n" +
      "(e.g., `ubuntu@api.mycompany.com` or `root@192.168.1.100`)"
    );
  },

  // ── Send message (user action) ─────────────────────────────────

  async sendMessage(text) {
    this.addMessage('user', text);

    switch (this.state) {
      case STATES.GREETING:
      case STATES.COLLECT_TARGET:
        await this.startOnboarding(text);
        break;

      case STATES.NEEDS_INSTALL:
        if (/^(done|ready|installed|ok|yes)[\s!.]*$/i.test(text.trim())) {
          await this.confirmAndConnect();
        } else {
          this.addMessage('agent', "Say **Done** when you've run the install command on your server. \u231B");
        }
        break;

      case STATES.BLOCKED:
        await this.handleBlockedInput(text);
        break;

      case STATES.ACTIVE_SESSION:
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'message', text: text }));
          this.showTyping();
        } else {
          this.addMessage('system', 'Connection lost. Trying to reconnect...');
        }
        break;

      case STATES.SESSION_ENDED:
        await this.startOnboarding(text);
        break;

      default:
        this.addMessage('system', 'Please wait...');
    }
  },

  // ── Onboarding: parse target ───────────────────────────────────

  async startOnboarding(userInput) {
    const match = userInput.trim().match(/^([a-z_][a-z0-9_-]*)@([a-zA-Z0-9._-]+)(?::(\d+))?$/);
    if (!match) {
      this.addMessage('agent',
        "Please provide in the format `user@host` (e.g., `ubuntu@myserver.com`).\n\n" +
        "You can also specify a port: `ubuntu@myserver.com:2222`"
      );
      this.setState(STATES.COLLECT_TARGET);
      return;
    }

    this.targetUser = match[1];
    this.targetHost = match[2];
    this.targetPort = match[3] ? parseInt(match[3], 10) : 22;

    await this.probeConnectivity(this.targetHost, this.targetPort);
  },

  // ── Probe connectivity ─────────────────────────────────────────

  async probeConnectivity(host, port) {
    this.setState(STATES.PROBING);
    this.addMessage('agent', 'Checking connectivity to `' + host + ':' + port + '`... ⏳');
    this.showTyping();

    try {
      const res = await this.api('POST', '/api/v1/connections/probe', { host, port });
      this.removeTyping();

      if (!res.ok) {
        if (res.status === 429) {
          this.addMessage('agent', 'Too many attempts. Please wait a moment and try again.');
          this.setState(STATES.COLLECT_TARGET);
          return;
        }
        this.addMessage('agent', 'Something went wrong checking connectivity. Try again in a moment.');
        this.setState(STATES.COLLECT_TARGET);
        return;
      }

      const probe = res.data;

      switch (probe.status) {
        case 'connectable':
          this.addMessage('agent', '✅ Port ' + port + ' is open on `' + host + '`.');
          await this.bootstrapConnection(host, this.targetUser, port);
          break;

        case 'dns_fail':
          this.setState(STATES.BLOCKED);
          this.addMessage('agent',
            '❌ Couldn\'t resolve hostname: `' + host + '`\n\n' +
            'This usually means:\n' +
            '• The hostname doesn\'t exist or isn\'t public\n' +
            '• There\'s a typo\n\n' +
            'Double-check the hostname, or try with an IP address instead.'
          );
          break;

        case 'port_fail':
          this.setState(STATES.BLOCKED);
          this.addMessage('agent',
            '❌ Port ' + port + ' on `' + host + '` isn\'t reachable from here.\n\n' +
            'This usually means:\n' +
            '• The server is behind a firewall or VPN\n' +
            '• SSH is running on a different port\n\n' +
            'Options:\n' +
            '• If you need VPN: connect to it, then say **retry**\n' +
            '• If SSH is on a different port: tell me (e.g., "port 2222")\n' +
            '• If there\'s a bastion host: let me know'
          );
          break;

        case 'ssh_fail':
          this.setState(STATES.BLOCKED);
          this.addMessage('agent',
            '⚠️ Port ' + port + ' on `' + host + '` is open, but it\'s not speaking SSH.\n\n' +
            'It might be running a different service on port ' + port + '.\n' +
            'Is SSH on a different port? (e.g., "port 2222")'
          );
          break;

        default:
          this.setState(STATES.COLLECT_TARGET);
          this.addMessage('agent', 'Unexpected probe result. Please try again.');
      }
    } catch (err) {
      this.removeTyping();
      this.addMessage('agent', 'Network error. Check your connection and try again.');
      this.setState(STATES.COLLECT_TARGET);
    }
  },

  // ── Blocked state handling ─────────────────────────────────────

  async handleBlockedInput(text) {
    const lower = text.trim().toLowerCase();

    if (lower === 'retry' || lower === 'try again') {
      await this.probeConnectivity(this.targetHost, this.targetPort);
      return;
    }

    const portMatch = lower.match(/^port\s+(\d+)$/);
    if (portMatch) {
      this.targetPort = parseInt(portMatch[1], 10);
      await this.probeConnectivity(this.targetHost, this.targetPort);
      return;
    }

    const ipMatch = text.trim().match(/^(?:ip\s+)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (ipMatch) {
      this.targetHost = ipMatch[1];
      await this.probeConnectivity(this.targetHost, this.targetPort);
      return;
    }

    const fullTarget = text.trim().match(/^([a-z_][a-z0-9_-]*)@([a-zA-Z0-9._-]+)(?::(\d+))?$/);
    if (fullTarget) {
      this.targetUser = fullTarget[1];
      this.targetHost = fullTarget[2];
      this.targetPort = fullTarget[3] ? parseInt(fullTarget[3], 10) : 22;
      await this.probeConnectivity(this.targetHost, this.targetPort);
      return;
    }

    this.addMessage('agent',
      'I can help! Try one of these:\n' +
      '• Say **retry** to probe again\n' +
      '• Say **port 2222** to try a different port\n' +
      '• Provide a new address (e.g., `user@host`)'
    );
  },

  // ── Bootstrap connection ───────────────────────────────────────

  async bootstrapConnection(host, username, port) {
    this.setState(STATES.NEEDS_INSTALL);
    this.showTyping();

    try {
      const res = await this.api('POST', '/api/v1/sessions/bootstrap', { host, username, port });
      this.removeTyping();

      if (!res.ok) {
        this.addMessage('agent', 'Error setting up connection: ' + (res.data?.message || 'Unknown error'));
        this.setState(STATES.COLLECT_TARGET);
        return;
      }

      this.connectionId = res.data.connection_id;

      if (res.data.status === 'ready') {
        this.addMessage('agent', '\u2705 You\'ve connected to this server before \u2014 reconnecting...');
        await this.confirmAndConnect();
        return;
      }

      var installCmd = res.data.install_command;
      this.addMessage('agent',
        'Run this command on **' + username + '@' + host + '** to install my SSH key:\n\n' +
        '```\n' + installCmd + '\n```\n\n' +
        'Say **Done** when you\'ve run it. \u231B',
        { installCommand: installCmd }
      );
    } catch (err) {
      this.removeTyping();
      this.addMessage('agent', 'Network error. Check your connection and try again.');
      this.setState(STATES.COLLECT_TARGET);
    }
  },

  // ── Confirm and connect ────────────────────────────────────────

  async confirmAndConnect() {
    this.setState(STATES.CONFIRMING);
    this.addMessage('agent', 'Testing connection to `' + this.targetUser + '@' + this.targetHost + '`... 🔍');
    this.showTyping();

    try {
      const res = await this.api('POST', '/api/v1/sessions/bootstrap/' + this.connectionId + '/confirm', { accept_host_key: true });
      this.removeTyping();

      if (!res.ok) {
        this.setState(STATES.NEEDS_INSTALL);
        const lastInstallCmd = this._lastInstallCommand;
        let msg = "❌ Couldn't connect. Make sure you've run the install command on the server, then say **Done** to try again.";
        if (lastInstallCmd) {
          msg += '\n\n```\n' + lastInstallCmd + '\n```';
        }
        this.addMessage('agent', msg);
        return;
      }

      this.sessionId = res.data.session_id;
      this.setState(STATES.STARTING);
      this.addMessage('agent', '✅ Connected to **' + this.targetUser + '@' + this.targetHost + '**! I can now run commands on this server.');
      this.connectWebSocket(this.sessionId);
      this.updateSessionIndicator();
      this.setState(STATES.ACTIVE_SESSION);

    } catch (err) {
      this.removeTyping();
      this.setState(STATES.NEEDS_INSTALL);
      this.addMessage('agent', 'Network error during connection test. Say **Done** to try again.');
    }
  },

  // ── End session ────────────────────────────────────────────────

  async endSession() {
    if (!this.sessionId) return;

    this.setState(STATES.SESSION_ENDED);
    if (this.ws) { this.ws.close(); this.ws = null; }

    try {
      await this.api('DELETE', '/api/v1/sessions/' + this.sessionId);
    } catch {}

    this.sessionId = null;
    this.connectionId = null;
    this.targetHost = null;
    this.targetUser = null;
    this.targetPort = null;
    this.updateSessionIndicator();
    this.setState(STATES.GREETING);
    this.addMessage('agent', 'Session ended. Which server would you like to connect to next?');
  },

  // ── Session restore ────────────────────────────────────────────

  async tryRestoreSession() {
    try {
      const res = await this.api('GET', '/api/v1/sessions');
      if (!res.ok) return;

      const active = res.data.sessions.find(s => s.status === 'active');
      if (!active) return;

      this.sessionId = active.id;
      this.targetHost = active.host;
      this.targetUser = active.username;
      this.targetPort = active.port;
      this.addMessage('system', 'Reconnecting to ' + active.username + '@' + active.host + '...');
      this.connectWebSocket(this.sessionId);
      this.setState(STATES.ACTIVE_SESSION);
    } catch {}
  },

  // ── WebSocket ──────────────────────────────────────────────────

  connectWebSocket(sessionId) {
    if (this.ws) { this.ws.close(); this.ws = null; }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = proto + '//' + window.location.host + '/ws/' + sessionId;

    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      // WS connected — server identifies session from URL
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleInbound(data);
      } catch {}
    };

    ws.onclose = () => {
      if (this.ws === ws && this.state === STATES.ACTIVE_SESSION) {
        this.addMessage('system', 'Connection to server was lost.');
        this.ws = null;
        this.sessionId = null;
        this.setState(STATES.GREETING);
        this.updateSessionIndicator();
        this.addMessage('agent', 'Which server would you like to connect to?');
      }
    };

    ws.onerror = () => {};
  },

  handleInbound(data) {
    switch (data.type) {
      case 'message':
        this.removeTyping();
        if (data.role === 'assistant' || data.role === 'agent') {
          this.addMessage('agent', data.text || data.content || '');
        }
        break;

      case 'session':
        // Session info from server on WS connect
        break;

      case 'status':
        if (data.status === 'thinking') this.showTyping();
        else if (data.status === 'done') this.removeTyping();
        break;

      case 'error':
        this.removeTyping();
        this.addMessage('system', 'Error: ' + (data.message || 'Unknown error'));
        break;
    }
  },

  // ── Public key display ─────────────────────────────────────────

  async showPublicKey() {
    this.closeMenu();
    try {
      const res = await this.api('GET', '/api/v1/keys/default/install-command');
      if (res.ok) {
        this.addMessage('agent',
          'Here\'s your public key install command:\n\n' +
          '```\n' + res.data.install_command + '\n```\n\n' +
          'Add this to any server\'s `~/.ssh/authorized_keys`.'
        );
      } else {
        this.addMessage('system', 'Could not retrieve your public key.');
      }
    } catch {
      this.addMessage('system', 'Network error. Could not retrieve your public key.');
    }
  },

  // ── Account menu ───────────────────────────────────────────────

  toggleMenu() {
    const menu = this.$.accountMenu();
    if (menu.hidden) {
      if (this.account) {
        this.$.menuName().textContent = this.account.display_name || this.account.login;
        this.$.menuLogin().textContent = '@' + this.account.login;
        if (this.account.avatar_url) {
          this.$.menuAvatar().style.backgroundImage = 'url(' + this.account.avatar_url + ')';
        }
      }
      menu.hidden = false;

      const overlay = document.createElement('div');
      overlay.className = 'menu-overlay';
      overlay.onclick = () => this.closeMenu();
      document.body.appendChild(overlay);
      this._menuOverlay = overlay;
    } else {
      this.closeMenu();
    }
  },

  closeMenu() {
    this.$.accountMenu().hidden = true;
    if (this._menuOverlay) {
      this._menuOverlay.remove();
      this._menuOverlay = null;
    }
  },

  // ── Chat UI ────────────────────────────────────────────────────

  addMessage(role, content, options) {
    options = options || {};
    const thread = this.$.thread();

    if (options.installCommand) {
      this._lastInstallCommand = options.installCommand;
    }

    const msgDiv = document.createElement('div');
    msgDiv.className = 'msg msg-' + role;
    if (options.id) msgDiv.id = options.id;

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.innerHTML = this.renderContent(content);

    bubble.querySelectorAll('.code-block-wrapper').forEach((wrapper) => {
      const btn = wrapper.querySelector('.btn-copy');
      const code = wrapper.querySelector('code');
      if (btn && code) {
        btn.addEventListener('click', () => {
          navigator.clipboard.writeText(code.textContent).then(() => {
            btn.textContent = 'Copied! ✓';
            btn.classList.add('copied');
            setTimeout(() => {
              btn.textContent = 'Copy';
              btn.classList.remove('copied');
            }, 2000);
          }).catch(() => {});
        });
      }
    });

    msgDiv.appendChild(bubble);
    thread.appendChild(msgDiv);
    this.scrollToBottom();
  },

  showTyping() {
    if (document.getElementById('typing-indicator')) return;
    const thread = this.$.thread();
    const div = document.createElement('div');
    div.id = 'typing-indicator';
    div.className = 'typing-indicator';
    div.innerHTML = '<div class="dots"><span></span><span></span><span></span></div>';
    thread.appendChild(div);
    this.scrollToBottom();
  },

  removeTyping() {
    const el = document.getElementById('typing-indicator');
    if (el) el.remove();
  },

  scrollToBottom() {
    const thread = this.$.thread();
    requestAnimationFrame(() => {
      thread.scrollTop = thread.scrollHeight;
    });
  },

  // ── Content renderer (markdown-lite) ───────────────────────────

  renderContent(text) {
    if (!text) return '';

    let html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function(_, lang, code) {
      return '<div class="code-block-wrapper"><pre><code>' +
        code.trim() +
        '</code></pre><button class="btn-copy">Copy</button></div>';
    });

    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    html = html.replace(/\n/g, '<br>');

    html = html.replace(/<div class="code-block-wrapper"><pre><code>([\s\S]*?)<\/code><\/pre>/g, function(match) {
      return match.replace(/<br>/g, '\n');
    });

    return html;
  },

  // ── API helper ─────────────────────────────────────────────────

  async api(method, path, body) {
    const opts = {
      method,
      headers: {},
      credentials: 'same-origin',
    };

    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(path, opts);

    if (res.status === 401) {
      this.account = null;
      this.$.screenChat().hidden = true;
      this.$.screenAuth().hidden = false;
      this.setState(STATES.AUTH);
      return { ok: false, status: 401, data: null };
    }

    if (res.status === 204) {
      return { ok: true, status: 204, data: null };
    }

    let data = null;
    try {
      data = await res.json();
    } catch {}

    return {
      ok: res.ok,
      status: res.status,
      data: data,
    };
  },
};

// Boot
document.addEventListener('DOMContentLoaded', () => app.init());
