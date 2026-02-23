import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "http";
import { readFileSync, existsSync } from "fs";
import { join, extname } from "path";
import { WebSocketServer, WebSocket } from "ws";
import { sessionStore } from "./sessions";
import { handleApiRequest } from "./api-router";
import { hashToken } from "./crypto";
import { query } from "./db";
import { apiError } from "./api-response";
import { startSessionCleanup } from "./routes/sessions";
import type { ClawdfatherConfig } from "./types";

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
};

/** Map of sessionId → Set of connected WebSocket clients */
const wsClients = new Map<string, Set<WebSocket>>();

export function sendToSession(sessionId: string, data: Record<string, unknown>): void {
  const clients = wsClients.get(sessionId);
  if (!clients) return;
  const json = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    }
  }
}

export function closeSessionClients(
  sessionId: string,
  code: number = 4001,
  reason: string = 'Session expired',
): void {
  const clients = wsClients.get(sessionId);
  if (!clients) return;
  for (const ws of clients) {
    try { ws.close(code, reason); } catch { /* already closed */ }
  }
  wsClients.delete(sessionId);
}

let singletonServer: HttpServer | null = null;
let singletonRefCount = 0;

function resolveAllowedOrigin(reqOrigin: string | undefined, config: ClawdfatherConfig): string | null {
  const allowed = config.allowedOrigins;
  if (!allowed || allowed.length === 0) {
    if (!reqOrigin) return null;
    try {
      const url = new URL(reqOrigin);
      if (url.hostname === config.webDomain || url.hostname === "localhost") {
        return reqOrigin;
      }
    } catch { /* malformed origin */ }
    return null;
  }
  if (allowed.includes("*")) return "*";
  if (reqOrigin && allowed.includes(reqOrigin)) return reqOrigin;
  return null;
}

export function startWebServer(
  config: ClawdfatherConfig,
  pluginRoot: string,
  onInbound: (sessionId: string, text: string, keyFingerprint: string) => Promise<void>
): { server: HttpServer; release: () => void } {
  if (singletonServer) {
    singletonRefCount++;
    return {
      server: singletonServer,
      release: () => {
        singletonRefCount--;
        if (singletonRefCount <= 0 && singletonServer) {
          singletonServer.close();
          singletonServer = null;
          singletonRefCount = 0;
        }
      },
    };
  }

  const port = config.webPort ?? 3000;
  const uiDir = join(pluginRoot, "ui");

  startSessionCleanup();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const reqOrigin = req.headers.origin;
    const allowedOrigin = resolveAllowedOrigin(reqOrigin, config);
    if (allowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const rawUrl = req.url ?? "/";
    const urlPath = rawUrl.split("?")[0];

    try {
      // Route API v1 and /health through the API router
      if (urlPath.startsWith("/api/v1/") || urlPath === "/health") {
        return await handleApiRequest(req, res, config);
      }

      // Legacy: /api/version
      if (urlPath === "/api/version") {
        let commitHash = "unknown";
        try {
          const { execSync } = require("child_process");
          commitHash = execSync("git rev-parse --short HEAD", { cwd: pluginRoot, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
        } catch {}
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ version: "0.2.0", commit: commitHash }));
        return;
      }

      // Legacy: /api/session/:id
      if (urlPath.startsWith("/api/session/")) {
        const sessionId = urlPath.replace("/api/session/", "");
        const session = sessionStore.get(sessionId);
        res.setHeader("Content-Type", "application/json");
        if (session) {
          sessionStore.touch(session.sessionId);
          res.writeHead(200);
          res.end(JSON.stringify({
            sessionId: session.sessionId,
            targetHost: session.targetHost,
            targetUser: session.targetUser,
            targetPort: session.targetPort,
            connectedAt: session.connectedAt,
            keyFingerprint: session.keyFingerprint,
          }));
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Session not found or expired" }));
        }
        return;
      }

      // Static files
      let filePath: string;
      if (urlPath === "/" || urlPath === "/index.html") {
        filePath = join(uiDir, "index.html");
      } else {
        const clean = urlPath.replace(/\.\./g, "");
        filePath = join(uiDir, clean);
      }

      if (!filePath.startsWith(uiDir)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      if (!existsSync(filePath)) {
        filePath = join(uiDir, "index.html");
      }

      try {
        const content = readFileSync(filePath);
        const ext = extname(filePath);
        res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
        res.end(content);
      } catch {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    } catch (err) {
      console.error("[clawdfather] Unhandled request error:", (err as Error).message);
      if (!res.headersSent) {
        apiError(res, 500, "internal_error", "An unexpected error occurred.");
      }
    }
  });

  // WebSocket server
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const wsOrigin = req.headers.origin;
    if (wsOrigin) {
      const allowed = resolveAllowedOrigin(wsOrigin, config);
      if (!allowed) {
        ws.close(4003, "Origin not allowed");
        return;
      }
    }

    let authenticatedSessionId: string | null = null;
    let keyFingerprint = "unknown";

    // Parse URL for /ws/sessions/:sessionId path
    const wsUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const wsSessionMatch = wsUrl.pathname.match(/\/ws\/sessions\/([^/]+)/);
    const urlSessionId = wsSessionMatch?.[1] ?? null;

    ws.on("message", async (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }

      if (msg.type === "auth") {
        const token = msg.token as string | undefined;
        const sessionId = (msg.sessionId ?? msg.session_id) as string | undefined;

        if (token) {
          const tokenH = hashToken(token);
          try {
            const result = await query(
              `SELECT s.account_id FROM app_sessions s
               JOIN accounts a ON a.id = s.account_id
               WHERE s.token_hash = $1 AND s.expires_at > NOW() AND s.revoked_at IS NULL AND a.is_active = TRUE`,
              [tokenH],
            );
            if (result.rows.length === 0) {
              ws.send(JSON.stringify({ type: "error", message: "Invalid or expired token" }));
              return;
            }
            const accountId = result.rows[0].account_id;

            const targetSessionId = sessionId ?? urlSessionId;
            if (targetSessionId) {
              const sessResult = await query(
                `SELECT id FROM session_leases WHERE id = $1 AND account_id = $2 AND status IN ('pending','active')`,
                [targetSessionId, accountId],
              );
              if (sessResult.rows.length === 0) {
                ws.send(JSON.stringify({ type: "error", message: "Session not found or not accessible" }));
                ws.close(4004, "Session not found");
                return;
              }
              authenticatedSessionId = targetSessionId;
              const memSession = sessionStore.get(targetSessionId);
              if (memSession) keyFingerprint = memSession.keyFingerprint;
            }
          } catch {
            ws.send(JSON.stringify({ type: "error", message: "Auth verification failed" }));
            return;
          }
        } else if (sessionId) {
          const session = sessionStore.get(sessionId);
          if (!session) {
            ws.send(JSON.stringify({ type: "error", message: "Session not found or expired" }));
            ws.close(4004, "Session not found");
            return;
          }
          authenticatedSessionId = sessionId;
          keyFingerprint = session.keyFingerprint;
        } else {
          ws.send(JSON.stringify({ type: "error", message: "Missing token or sessionId" }));
          return;
        }

        if (authenticatedSessionId) {
          if (!wsClients.has(authenticatedSessionId)) {
            wsClients.set(authenticatedSessionId, new Set());
          }
          wsClients.get(authenticatedSessionId)!.add(ws);

          const session = sessionStore.get(authenticatedSessionId);
          ws.send(JSON.stringify({
            type: "session",
            session_id: authenticatedSessionId,
            connection: session ? {
              label: `${session.targetUser}@${session.targetHost}`,
              host: session.targetHost,
              username: session.targetUser,
            } : undefined,
          }));
        } else {
          ws.send(JSON.stringify({ type: "auth_ok" }));
        }

        return;
      }

      if (msg.type === "heartbeat") {
        if (authenticatedSessionId) {
          sessionStore.touch(authenticatedSessionId);
          query(
            `UPDATE session_leases SET last_heartbeat_at = NOW() WHERE id = $1 AND status = 'active'`,
            [authenticatedSessionId],
          ).catch(() => {});
        }
        ws.send(JSON.stringify({ type: "heartbeat_ack", server_time: new Date().toISOString() }));
        return;
      }

      if (msg.type === "message") {
        if (!authenticatedSessionId) {
          ws.send(JSON.stringify({ type: "error", message: "Not authenticated. Send auth first." }));
          return;
        }

        const liveSession = sessionStore.get(authenticatedSessionId);
        if (!liveSession) {
          ws.send(JSON.stringify({ type: "error", message: "Session expired or invalidated" }));
          ws.close(4001, "Session expired");
          return;
        }
        sessionStore.touch(authenticatedSessionId);

        const text = (msg.text as string)?.trim();
        if (!text) return;

        try {
          sendToSession(authenticatedSessionId, { type: "status", status: "thinking" });
          await onInbound(authenticatedSessionId, text, keyFingerprint);
          sendToSession(authenticatedSessionId, { type: "status", status: "done" });
        } catch (err: unknown) {
          ws.send(JSON.stringify({ type: "error", message: (err as Error).message }));
          sendToSession(authenticatedSessionId, { type: "status", status: "done" });
        }

        return;
      }

      ws.send(JSON.stringify({ type: "error", message: `Unknown message type: ${msg.type}` }));
    });

    ws.on("close", () => {
      if (authenticatedSessionId) {
        const clients = wsClients.get(authenticatedSessionId);
        if (clients) {
          clients.delete(ws);
          if (clients.size === 0) {
            wsClients.delete(authenticatedSessionId);
          }
        }
      }
    });
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[clawdfather] Web server listening on port ${port}`);
  });

  singletonServer = server;
  singletonRefCount = 1;

  return {
    server,
    release: () => {
      singletonRefCount--;
      if (singletonRefCount <= 0 && singletonServer) {
        singletonServer.close();
        singletonServer = null;
        singletonRefCount = 0;
      }
    },
  };
}
