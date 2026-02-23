/**
 * Tests for session-first onboarding handlers (handleBootstrapSession, handleConfirmAndStartSession).
 * Uses node:test + node:assert with module-level mocking.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'http';

// ── Mock state ──────────────────────────────────────────────────────────────

let mockQueryResults: { rows: Record<string, unknown>[] }[] = [];
let mockQueryCallIndex = 0;
let mockAuthResult: any = null;
let mockSshTestResult: any = { result: 'ok', latency_ms: 50, host_key_fingerprint: 'SHA256:newkey', message: 'SSH connection successful.' };
let mockSocketExists = true;

// ── Install mocks before onboarding module loads ────────────────────────────

const dbModule = require('../db');
dbModule.query = async () => {
  const result = mockQueryResults[mockQueryCallIndex] ?? { rows: [] };
  mockQueryCallIndex++;
  return result;
};

const authMiddleware = require('../auth-middleware');
authMiddleware.authenticate = async (_req: unknown, res: unknown) => {
  if (!mockAuthResult) {
    const r = res as ServerResponse;
    r.writeHead(401, { 'Content-Type': 'application/json' });
    r.end(JSON.stringify({ error: { code: 'unauthorized', message: 'Not authenticated.' } }));
    return null;
  }
  return mockAuthResult;
};

const auditModule = require('../audit');
auditModule.auditLog = () => {};

const sessionsModule = require('../sessions');
sessionsModule.sessionStore = { create: () => {}, get: () => undefined, remove: () => {} };

const sshTestModule = require('../ssh-test');
sshTestModule.testSSHConnection = async () => mockSshTestResult;

const cp = require('child_process');
cp.spawn = () => ({ unref: () => {} });
const originalExecSync = cp.execSync;
cp.execSync = (...args: unknown[]) => {
  const cmd = args[0] as string;
  if (typeof cmd === 'string' && cmd.startsWith('ssh-keygen')) {
    return originalExecSync(...(args as [string, ...unknown[]]));
  }
};

const fsModule = require('fs');
const originalExistsSync = fsModule.existsSync;
fsModule.existsSync = (p: string) => {
  if (p && p.includes('/tmp/clawdfather/') && p.endsWith('.sock')) return mockSocketExists;
  return originalExistsSync(p);
};
fsModule.writeFileSync = () => {};
fsModule.unlinkSync = () => {};
fsModule.mkdirSync = () => {};

const cryptoModule = require('../crypto');
cryptoModule.deriveAccountKEK = () => 'fakekek';
cryptoModule.decryptPrivateKey = () => '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n';
cryptoModule.encryptPrivateKey = () => 'encrypted';
cryptoModule.computeEd25519Fingerprint = () => 'SHA256:fakefingerprint';

const { handleBootstrapSession, handleConfirmAndStartSession } = require('./onboarding');

// ── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_AUTH = {
  account: {
    id: 'acct-1',
    display_name: 'Test User',
    email: 'test@example.com',
    created_at: '2025-01-01',
    last_seen_at: '2025-01-01',
    is_active: true,
  },
  tokenHash: 'testhash',
};

const DEFAULT_CONFIG = {
  sshPort: 22,
  webPort: 3000,
  webDomain: 'localhost:3000',
  sessionTimeoutMs: 1800000,
};

function mockReq(opts: { url?: string; method?: string; body?: unknown }): IncomingMessage {
  const bodyStr = opts.body ? JSON.stringify(opts.body) : '';
  const bodyBuf = Buffer.from(bodyStr);
  const listeners: Record<string, Function[]> = {};
  const req = {
    url: opts.url ?? '/api/v1/sessions/bootstrap',
    method: opts.method ?? 'POST',
    headers: { authorization: 'Bearer testtoken', host: 'localhost:3000', 'content-length': String(bodyBuf.length) },
    socket: { remoteAddress: '127.0.0.1' },
    on(ev: string, cb: Function) {
      if (!listeners[ev]) listeners[ev] = [];
      listeners[ev].push(cb);
      if (ev === 'end') {
        process.nextTick(() => {
          for (const fn of (listeners['data'] ?? [])) fn(bodyBuf);
          for (const fn of (listeners['end'] ?? [])) fn();
        });
      }
      return this;
    },
  } as unknown as IncomingMessage;
  return req;
}

function mockRes() {
  const r: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: '',
    ended: false,
    headersSent: false,
    setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; },
    writeHead(s: number, h?: any) { this.statusCode = s; if (h) for (const [k, v] of Object.entries(h)) this.headers[k.toLowerCase()] = v; },
    end(d?: string) { this.body = d ?? ''; this.ended = true; },
    json() { return JSON.parse(this.body); },
  };
  return r;
}

// ── Tests: handleBootstrapSession ───────────────────────────────────────────

describe('handleBootstrapSession', () => {
  beforeEach(() => {
    mockQueryCallIndex = 0;
    mockQueryResults = [];
    mockAuthResult = DEFAULT_AUTH;
    mockSshTestResult = { result: 'ok', latency_ms: 50, host_key_fingerprint: 'SHA256:newkey', message: 'SSH connection successful.' };
    mockSocketExists = true;
  });

  it('returns 401 when not authenticated', async () => {
    mockAuthResult = null;

    const req = mockReq({ body: { host: '1.2.3.4', username: 'root' } });
    const res = mockRes();

    await handleBootstrapSession(req, res as unknown as ServerResponse, DEFAULT_CONFIG);

    assert.equal(res.statusCode, 401);
  });

  it('returns 400 when host is missing', async () => {
    const req = mockReq({ body: { username: 'root' } });
    const res = mockRes();

    await handleBootstrapSession(req, res as unknown as ServerResponse, DEFAULT_CONFIG);

    assert.equal(res.statusCode, 400);
    const data = res.json();
    assert.equal(data.error.code, 'validation_error');
  });

  it('returns 400 when username is missing', async () => {
    const req = mockReq({ body: { host: '1.2.3.4' } });
    const res = mockRes();

    await handleBootstrapSession(req, res as unknown as ServerResponse, DEFAULT_CONFIG);

    assert.equal(res.statusCode, 400);
    const data = res.json();
    assert.equal(data.error.code, 'validation_error');
  });

  it('returns 400 when username has invalid format', async () => {
    const req = mockReq({ body: { host: '1.2.3.4', username: 'Root!' } });
    const res = mockRes();

    await handleBootstrapSession(req, res as unknown as ServerResponse, DEFAULT_CONFIG);

    assert.equal(res.statusCode, 400);
    const data = res.json();
    assert.equal(data.error.code, 'validation_error');
  });

  it('returns needs_setup when new connection created', async () => {
    mockQueryResults = [
      { rows: [{ id: 'kp-1', public_key: 'ssh-ed25519 AAA', fingerprint: 'SHA256:fp1' }] },
      { rows: [] },
      { rows: [{ id: 'conn-1' }] },
    ];

    const req = mockReq({ body: { host: '1.2.3.4', username: 'root' } });
    const res = mockRes();

    await handleBootstrapSession(req, res as unknown as ServerResponse, DEFAULT_CONFIG);

    assert.equal(res.statusCode, 200);
    const data = res.json();
    assert.equal(data.status, 'needs_setup');
    assert.equal(data.connection_id, 'conn-1');
    assert.ok(data.install_command.includes('ssh-ed25519 AAA'));
  });

  it('returns ready when existing tested connection found', async () => {
    mockQueryResults = [
      { rows: [{ id: 'kp-1', public_key: 'ssh-ed25519 BBB', fingerprint: 'SHA256:fp2' }] },
      { rows: [{ id: 'conn-existing', last_test_result: 'ok' }] },
    ];

    const req = mockReq({ body: { host: '1.2.3.4', username: 'root' } });
    const res = mockRes();

    await handleBootstrapSession(req, res as unknown as ServerResponse, DEFAULT_CONFIG);

    assert.equal(res.statusCode, 200);
    const data = res.json();
    assert.equal(data.status, 'ready');
    assert.equal(data.connection_id, 'conn-existing');
  });

  it('returns needs_setup with existing untested connection', async () => {
    mockQueryResults = [
      { rows: [{ id: 'kp-1', public_key: 'ssh-ed25519 CCC', fingerprint: 'SHA256:fp3' }] },
      { rows: [{ id: 'conn-2', last_test_result: 'failed' }] },
    ];

    const req = mockReq({ body: { host: '1.2.3.4', username: 'root' } });
    const res = mockRes();

    await handleBootstrapSession(req, res as unknown as ServerResponse, DEFAULT_CONFIG);

    assert.equal(res.statusCode, 200);
    const data = res.json();
    assert.equal(data.status, 'needs_setup');
    assert.equal(data.connection_id, 'conn-2');
  });
});

// ── Tests: handleConfirmAndStartSession ─────────────────────────────────────

describe('handleConfirmAndStartSession', () => {
  beforeEach(() => {
    mockQueryCallIndex = 0;
    mockQueryResults = [];
    mockAuthResult = DEFAULT_AUTH;
    mockSshTestResult = { result: 'ok', latency_ms: 50, host_key_fingerprint: 'SHA256:newkey', message: 'SSH connection successful.' };
    mockSocketExists = true;
  });

  it('returns 401 when not authenticated', async () => {
    mockAuthResult = null;

    const req = mockReq({ url: '/api/v1/sessions/bootstrap/conn-1/confirm', body: {} });
    const res = mockRes();

    await handleConfirmAndStartSession(req, res as unknown as ServerResponse, 'conn-1', DEFAULT_CONFIG);

    assert.equal(res.statusCode, 401);
  });

  it('returns 404 when connection not found', async () => {
    mockQueryResults = [{ rows: [] }];

    const req = mockReq({ url: '/api/v1/sessions/bootstrap/conn-1/confirm', body: {} });
    const res = mockRes();

    await handleConfirmAndStartSession(req, res as unknown as ServerResponse, 'conn-1', DEFAULT_CONFIG);

    assert.equal(res.statusCode, 404);
    const data = res.json();
    assert.equal(data.error.code, 'not_found');
  });

  it('returns 409 when keypair revoked', async () => {
    mockQueryResults = [
      {
        rows: [{
          id: 'conn-1', host: '1.2.3.4', port: 22, username: 'root', label: 'test',
          keypair_id: 'kp-1', private_key_enc: 'enc', kp_active: false,
          host_key_fingerprint: null, fingerprint: 'SHA256:fp',
        }],
      },
    ];

    const req = mockReq({ url: '/api/v1/sessions/bootstrap/conn-1/confirm', body: {} });
    const res = mockRes();

    await handleConfirmAndStartSession(req, res as unknown as ServerResponse, 'conn-1', DEFAULT_CONFIG);

    assert.equal(res.statusCode, 409);
    const data = res.json();
    assert.equal(data.error.code, 'keypair_revoked');
  });

  it('returns 502 when SSH test fails', async () => {
    mockSshTestResult = { result: 'failed', latency_ms: null, host_key_fingerprint: null, message: 'Connection refused.' };
    mockQueryResults = [
      {
        rows: [{
          id: 'conn-1', host: '1.2.3.4', port: 22, username: 'root', label: 'test',
          keypair_id: 'kp-1', private_key_enc: 'enc', kp_active: true,
          host_key_fingerprint: null, fingerprint: 'SHA256:fp',
        }],
      },
      { rows: [] }, // update connection query
    ];

    const req = mockReq({ url: '/api/v1/sessions/bootstrap/conn-1/confirm', body: {} });
    const res = mockRes();

    await handleConfirmAndStartSession(req, res as unknown as ServerResponse, 'conn-1', DEFAULT_CONFIG);

    assert.equal(res.statusCode, 502);
    const data = res.json();
    assert.equal(data.error.code, 'ssh_connect_failed');
  });

  it('returns 409 when session limit reached', async () => {
    mockQueryResults = [
      {
        rows: [{
          id: 'conn-1', host: '1.2.3.4', port: 22, username: 'root', label: 'test',
          keypair_id: 'kp-1', private_key_enc: 'enc', kp_active: true,
          host_key_fingerprint: null, fingerprint: 'SHA256:fp',
        }],
      },
      { rows: [] }, // update connection
      { rows: [{ cnt: '3' }] }, // session count
    ];

    const req = mockReq({ url: '/api/v1/sessions/bootstrap/conn-1/confirm', body: {} });
    const res = mockRes();

    await handleConfirmAndStartSession(req, res as unknown as ServerResponse, 'conn-1', DEFAULT_CONFIG);

    assert.equal(res.statusCode, 409);
    const data = res.json();
    assert.equal(data.error.code, 'session_limit_reached');
  });

  it('returns 201 on success', async () => {
    mockSocketExists = true;
    mockQueryResults = [
      {
        rows: [{
          id: 'conn-1', host: '1.2.3.4', port: 22, username: 'root', label: 'test',
          keypair_id: 'kp-1', private_key_enc: 'enc', kp_active: true,
          host_key_fingerprint: null, fingerprint: 'SHA256:fp',
        }],
      },
      { rows: [] }, // update connection
      { rows: [{ cnt: '0' }] }, // session count
      { rows: [] }, // insert session
      { rows: [] }, // update session to active
    ];

    const req = mockReq({ url: '/api/v1/sessions/bootstrap/conn-1/confirm', body: {} });
    const res = mockRes();

    await handleConfirmAndStartSession(req, res as unknown as ServerResponse, 'conn-1', DEFAULT_CONFIG);

    assert.equal(res.statusCode, 201);
    const data = res.json();
    assert.equal(data.session.status, 'active');
    assert.ok(data.session.chat_url.includes('/?session='));
    assert.equal(data.session.connection.id, 'conn-1');
  });
});
