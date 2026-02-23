/**
 * Tests for session route handlers (handleListSessions, handleGetSession, handleDeleteSession).
 * Uses node:test + node:assert with module-level DB/auth mocking.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "http";

// ── Mock state ──────────────────────────────────────────────────────────────

let mockQueryResults: { rows: Record<string, unknown>[] }[] = [];
let mockQueryCallIndex = 0;
let mockAuthResult: { account: { id: string; display_name: string; email: string; created_at: string; last_seen_at: string; is_active: boolean }; tokenHash: string } | null = null;
let mockCloseSessionClientsCalls: { sessionId: string; code: number; reason: string }[] = [];

// ── Install mocks before sessions module loads ────────────────────────────

const dbModule = require("../db");
dbModule.query = async () => {
  const result = mockQueryResults[mockQueryCallIndex] ?? { rows: [] };
  mockQueryCallIndex++;
  return result;
};

const authMiddleware = require("../auth-middleware");
authMiddleware.authenticate = async (_req: unknown, res: unknown) => {
  if (!mockAuthResult) {
    const r = res as ServerResponse;
    r.writeHead(401, { "Content-Type": "application/json" });
    r.end(JSON.stringify({ error: { code: "unauthorized", message: "Missing or invalid auth token." } }));
    return null;
  }
  return mockAuthResult;
};

const auditModule = require("../audit");
auditModule.auditLog = () => {};

const webServerModule = require("../web-server");
webServerModule.closeSessionClients = (sessionId: string, code: number, reason: string) => {
  mockCloseSessionClientsCalls.push({ sessionId, code, reason });
};

const sessionsModule = require("../sessions");
sessionsModule.sessionStore.remove = () => {};

// Now import the handlers (they'll pick up the mocked modules)
const { handleListSessions, handleGetSession, handleDeleteSession } = require("./sessions");

// ── Mock helpers ────────────────────────────────────────────────────────────

function mockReq(opts: {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  return {
    url: opts.url ?? "/api/v1/sessions",
    method: opts.method ?? "GET",
    headers: opts.headers ?? { authorization: "Bearer testtoken", host: "localhost:3000" },
    socket: { remoteAddress: "127.0.0.1" },
    on: () => {},
  } as unknown as IncomingMessage;
}

interface MockRes {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
  ended: boolean;
  headersSent: boolean;
  setHeader(name: string, value: string | string[]): void;
  writeHead(status: number, headers?: Record<string, string>): void;
  end(data?: string): void;
  json(): unknown;
}

function mockRes(): MockRes {
  const r: MockRes = {
    statusCode: 200,
    headers: {},
    body: "",
    ended: false,
    headersSent: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(status, hdrs) { this.statusCode = status; if (hdrs) for (const [k, v] of Object.entries(hdrs)) this.headers[k.toLowerCase()] = v; },
    end(data?: string) { this.body = data ?? ""; this.ended = true; },
    json() { return JSON.parse(this.body); },
  };
  return r;
}

const DEFAULT_AUTH = {
  account: {
    id: "acct-1",
    display_name: "Test User",
    email: "test@example.com",
    created_at: "2025-01-01T00:00:00Z",
    last_seen_at: "2025-01-01T00:00:00Z",
    is_active: true,
  },
  tokenHash: "testhash",
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe("handleListSessions", () => {
  beforeEach(() => {
    mockQueryCallIndex = 0;
    mockQueryResults = [];
    mockAuthResult = DEFAULT_AUTH;
    mockCloseSessionClientsCalls = [];
  });

  it("returns sessions with correct fields", async () => {
    mockQueryResults = [
      {
        rows: [
          {
            id: "sess-1",
            status: "active",
            agent_session_id: "ssh:sess-1",
            started_at: "2025-06-01T10:00:00Z",
            last_heartbeat_at: "2025-06-01T10:05:00Z",
            conn_id: "conn-1",
            conn_label: "My Server",
            conn_host: "192.168.1.1",
            created_at: "2025-06-01T09:59:00Z",
          },
        ],
      },
      { rows: [{ cnt: "1" }] },
    ];

    const req = mockReq({ url: "/api/v1/sessions" });
    const res = mockRes();

    await handleListSessions(req, res as unknown as ServerResponse);

    assert.equal(res.statusCode, 200);
    const data = res.json() as { sessions: unknown[]; total: number; limit: number; offset: number };
    assert.equal(data.sessions.length, 1);
    assert.equal(data.total, 1);

    const sess = data.sessions[0] as Record<string, unknown>;
    assert.equal(sess.id, "sess-1");
    assert.equal(sess.status, "active");
    const conn = sess.connection as Record<string, unknown>;
    assert.equal(conn.id, "conn-1");
    assert.equal(conn.label, "My Server");
    assert.equal(conn.host, "192.168.1.1");
  });

  it("returns empty list when no sessions exist", async () => {
    mockQueryResults = [
      { rows: [] },
      { rows: [{ cnt: "0" }] },
    ];

    const req = mockReq({ url: "/api/v1/sessions" });
    const res = mockRes();

    await handleListSessions(req, res as unknown as ServerResponse);

    assert.equal(res.statusCode, 200);
    const data = res.json() as { sessions: unknown[]; total: number };
    assert.equal(data.sessions.length, 0);
    assert.equal(data.total, 0);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuthResult = null;

    const req = mockReq({ url: "/api/v1/sessions", headers: {} });
    const res = mockRes();

    await handleListSessions(req, res as unknown as ServerResponse);

    assert.equal(res.statusCode, 401);
  });
});

describe("handleGetSession", () => {
  beforeEach(() => {
    mockQueryCallIndex = 0;
    mockQueryResults = [];
    mockAuthResult = DEFAULT_AUTH;
    mockCloseSessionClientsCalls = [];
  });

  it("returns 404 for unknown session", async () => {
    mockQueryResults = [{ rows: [] }];

    const req = mockReq({ url: "/api/v1/sessions/nonexistent" });
    const res = mockRes();

    const config = { webDomain: "localhost:3000" };
    await handleGetSession(req, res as unknown as ServerResponse, "nonexistent", config);

    assert.equal(res.statusCode, 404);
    const data = res.json() as { error: { code: string } };
    assert.equal(data.error.code, "not_found");
  });

  it("returns session details for known session", async () => {
    mockQueryResults = [
      {
        rows: [{
          id: "sess-1",
          status: "active",
          agent_session_id: "ssh:sess-1",
          started_at: "2025-06-01T10:00:00Z",
          last_heartbeat_at: "2025-06-01T10:05:00Z",
          close_reason: null,
          conn_id: "conn-1",
          conn_label: "My Server",
          conn_host: "192.168.1.1",
          conn_port: 22,
          conn_username: "root",
        }],
      },
    ];

    const req = mockReq({ url: "/api/v1/sessions/sess-1" });
    const res = mockRes();

    const config = { webDomain: "app.example.com" };
    await handleGetSession(req, res as unknown as ServerResponse, "sess-1", config);

    assert.equal(res.statusCode, 200);
    const data = res.json() as { session: Record<string, unknown> };
    assert.equal(data.session.id, "sess-1");
    assert.equal(data.session.status, "active");

    const conn = data.session.connection as Record<string, unknown>;
    assert.equal(conn.label, "My Server");
    assert.equal(conn.host, "192.168.1.1");
    assert.equal(conn.port, 22);
    assert.equal(conn.username, "root");

    assert.ok((data.session.chat_url as string).includes("app.example.com"));
  });
});

describe("handleDeleteSession", () => {
  beforeEach(() => {
    mockQueryCallIndex = 0;
    mockQueryResults = [];
    mockAuthResult = DEFAULT_AUTH;
    mockCloseSessionClientsCalls = [];
  });

  it("returns 404 for unknown session", async () => {
    mockQueryResults = [{ rows: [] }];

    const req = mockReq({ method: "DELETE", url: "/api/v1/sessions/nonexistent" });
    const res = mockRes();

    await handleDeleteSession(req, res as unknown as ServerResponse, "nonexistent");

    assert.equal(res.statusCode, 404);
    const data = res.json() as { error: { code: string } };
    assert.equal(data.error.code, "not_found");
  });

  it("returns 200 idempotently for already-closed session", async () => {
    mockQueryResults = [
      {
        rows: [{
          id: "sess-closed",
          status: "closed",
          closed_at: "2025-06-01T11:00:00Z",
          close_reason: "user",
          conn_username: "root",
          conn_host: "192.168.1.1",
          conn_port: 22,
        }],
      },
    ];

    const req = mockReq({ method: "DELETE", url: "/api/v1/sessions/sess-closed" });
    const res = mockRes();

    await handleDeleteSession(req, res as unknown as ServerResponse, "sess-closed");

    assert.equal(res.statusCode, 200);
    const data = res.json() as { session: Record<string, unknown> };
    assert.equal(data.session.status, "closed");
    assert.equal(data.session.close_reason, "user");
    assert.equal(mockCloseSessionClientsCalls.length, 0, "should not attempt to close WS clients for already-closed session");
  });

  it("returns 200 idempotently for error-status session", async () => {
    mockQueryResults = [
      {
        rows: [{
          id: "sess-err",
          status: "error",
          closed_at: "2025-06-01T11:00:00Z",
          close_reason: "ssh_failed",
          conn_username: "root",
          conn_host: "192.168.1.1",
          conn_port: 22,
        }],
      },
    ];

    const req = mockReq({ method: "DELETE", url: "/api/v1/sessions/sess-err" });
    const res = mockRes();

    await handleDeleteSession(req, res as unknown as ServerResponse, "sess-err");

    assert.equal(res.statusCode, 200);
    const data = res.json() as { session: Record<string, unknown> };
    assert.equal(data.session.status, "error");
  });
});
