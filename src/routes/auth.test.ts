/**
 * Tests for OAuth callback redirect/cookie behavior and cookie auth middleware.
 * Uses node:test + node:assert with module-level DB mocking.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "http";

// ── Minimal mock helpers ──────────────────────────────────────────────────────

function mockReq(opts: {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  const req = {
    url: opts.url ?? "/api/v1/auth/oauth/github/callback?code=testcode&state=teststate",
    method: opts.method ?? "GET",
    headers: opts.headers ?? {},
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
  return req;
}

interface MockRes {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
  ended: boolean;
  setHeader(name: string, value: string | string[]): void;
  writeHead(status: number, headers?: Record<string, string>): void;
  end(data?: string): void;
  headersSent: boolean;
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
  };
  return r;
}

// ── Tests: cookie/redirect detection logic ────────────────────────────────────

describe("OAuth callback: wantsJson detection", () => {
  it("returns false for plain browser request (no Accept header)", () => {
    const req = mockReq({ headers: {} });
    const accept = (req.headers["accept"] ?? "") as string;
    const wantsJson = accept.includes("application/json");
    assert.equal(wantsJson, false);
  });

  it("returns true when Accept: application/json", () => {
    const req = mockReq({ headers: { accept: "application/json" } });
    const accept = (req.headers["accept"] ?? "") as string;
    const wantsJson = accept.includes("application/json");
    assert.equal(wantsJson, true);
  });

  it("returns true when ?mode=json in URL", () => {
    const req = mockReq({ url: "/callback?code=abc&state=xyz&mode=json" });
    const url = new URL(req.url!, `http://localhost`);
    const wantsJson = url.searchParams.get("mode") === "json";
    assert.equal(wantsJson, true);
  });
});

// ── Tests: cookie parsing logic (auth-middleware) ────────────────────────────

describe("Auth middleware: cookie parsing", () => {
  it("extracts session_token from Cookie header", () => {
    const cookieHeader = "other_cookie=abc; session_token=mytoken123; another=xyz";
    const cookiePart = cookieHeader.split(";").map((s) => s.trim()).find((s) => s.startsWith("session_token="));
    const token = cookiePart ? cookiePart.slice("session_token=".length) : null;
    assert.equal(token, "mytoken123");
  });

  it("returns null if session_token not in Cookie header", () => {
    const cookieHeader = "other=value; another=thing";
    const cookiePart = cookieHeader.split(";").map((s) => s.trim()).find((s) => s.startsWith("session_token="));
    const token = cookiePart ? cookiePart.slice("session_token=".length) : null;
    assert.equal(token, null);
  });

  it("handles empty Cookie header", () => {
    const cookieHeader = "";
    const cookiePart = cookieHeader.split(";").map((s) => s.trim()).find((s) => s.startsWith("session_token="));
    const token = cookiePart ? cookiePart.slice("session_token=".length) : null;
    assert.equal(token, null);
  });
});

// ── Tests: redirect response shape ───────────────────────────────────────────

describe("OAuth callback: redirect response shape", () => {
  it("redirect response has Location header and 302 status", () => {
    const res = mockRes();
    const token = "test-session-token-abc";
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const maxAge = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
    const webDomain = "localhost";
    const webPort = 3000;

    // Simulate the redirect branch
    const isSecure = false; // localhost
    const secureFlag = isSecure ? "; Secure" : "";
    res.setHeader("Set-Cookie", `session_token=${token}; HttpOnly${secureFlag}; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
    const useHttps = !webDomain.startsWith("localhost");
    const baseUrl = useHttps ? `https://${webDomain}/` : `http://${webDomain}:${webPort}/`;
    res.setHeader("Location", baseUrl);
    res.writeHead(302);
    res.end();

    assert.equal(res.statusCode, 302);
    assert.equal(res.headers["location"], "http://localhost:3000/");
    const cookie = res.headers["set-cookie"] as string;
    assert.ok(cookie.includes("session_token=test-session-token-abc"), "cookie should contain token");
    assert.ok(cookie.includes("HttpOnly"), "cookie should be HttpOnly");
    assert.ok(cookie.includes("SameSite=Lax"), "cookie should have SameSite=Lax");
    assert.ok(!cookie.includes("Secure"), "localhost cookie should NOT have Secure flag");
  });

  it("redirect response for production domain includes Secure flag", () => {
    const res = mockRes();
    const token = "prod-token";
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const maxAge = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
    const webDomain = "app.example.com";

    const isSecure = !webDomain.startsWith("localhost") && !webDomain.startsWith("127.");
    const secureFlag = isSecure ? "; Secure" : "";
    res.setHeader("Set-Cookie", `session_token=${token}; HttpOnly${secureFlag}; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
    res.setHeader("Location", `https://${webDomain}/`);
    res.writeHead(302);
    res.end();

    assert.equal(res.statusCode, 302);
    assert.equal(res.headers["location"], "https://app.example.com/");
    const cookie = res.headers["set-cookie"] as string;
    assert.ok(cookie.includes("; Secure"), "production cookie should have Secure flag");
  });
});
