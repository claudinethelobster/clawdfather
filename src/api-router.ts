import type { IncomingMessage, ServerResponse } from 'http';
import { apiError } from './api-response';
import { handleHealth } from './routes/health';
import {
  handleOAuthGitHubStart,
  handleOAuthGitHubCallback,
  handleDeleteSession as handleDeleteAppSession,
  handleGetMe,
} from './routes/auth';
import {
  handleListKeys,
  handleCreateKey,
  handleGetInstallCommand,
  handleDeleteKey,
} from './routes/keys';
import {
  handleListConnections,
  handleCreateConnection,
  handleUpdateConnection,
  handleDeleteConnection,
  handleTestConnection,
} from './routes/connections';
import {
  handleCreateSession,
  handleListSessions,
  handleGetSession,
  handleDeleteSession,
} from './routes/sessions';
import {
  handleBootstrapSession,
  handleConfirmAndStartSession,
} from './routes/onboarding';
import { handleGetAudit } from './routes/audit';
import type { ClawdfatherConfig } from './types';

function parsePathSegments(pathname: string): string[] {
  return pathname.split('/').filter(Boolean);
}

export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: ClawdfatherConfig,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method ?? 'GET';

  try {
    // GET /health
    if (pathname === '/health' && method === 'GET') {
      return await handleHealth(req, res);
    }

    const segments = parsePathSegments(pathname);

    // All other API routes are under /api/v1/...
    if (segments[0] !== 'api' || segments[1] !== 'v1') {
      return apiError(res, 404, 'not_found', 'Route not found.');
    }

    const resource = segments[2];

    // --- Auth routes ---
    if (resource === 'auth') {
      const sub = segments.slice(3).join('/');

      if (sub === 'oauth/github/start' && method === 'POST') {
        return await handleOAuthGitHubStart(req, res, config);
      }
      if (sub === 'oauth/github/callback' && method === 'GET') {
        return await handleOAuthGitHubCallback(req, res, config);
      }
      if (sub === 'session' && method === 'DELETE') {
        return await handleDeleteAppSession(req, res);
      }
      if (sub === 'me' && method === 'GET') {
        return await handleGetMe(req, res);
      }

      return apiError(res, 404, 'not_found', 'Route not found.');
    }

    // --- Keys routes ---
    if (resource === 'keys') {
      if (segments.length === 3) {
        if (method === 'GET') return await handleListKeys(req, res);
        if (method === 'POST') return await handleCreateKey(req, res, config);
        return apiError(res, 405, 'method_not_allowed', 'Method not allowed.');
      }
      const keyId = segments[3];
      if (segments.length === 4) {
        if (method === 'DELETE') return await handleDeleteKey(req, res, keyId);
        return apiError(res, 405, 'method_not_allowed', 'Method not allowed.');
      }
      if (segments.length === 5 && segments[4] === 'install-command' && method === 'GET') {
        return await handleGetInstallCommand(req, res, keyId);
      }

      return apiError(res, 404, 'not_found', 'Route not found.');
    }

    // --- Connections routes ---
    if (resource === 'connections') {
      if (segments.length === 3) {
        if (method === 'GET') return await handleListConnections(req, res);
        if (method === 'POST') return await handleCreateConnection(req, res);
        return apiError(res, 405, 'method_not_allowed', 'Method not allowed.');
      }
      const connId = segments[3];
      if (segments.length === 4) {
        if (method === 'PATCH') return await handleUpdateConnection(req, res, connId);
        if (method === 'DELETE') return await handleDeleteConnection(req, res, connId);
        return apiError(res, 405, 'method_not_allowed', 'Method not allowed.');
      }
      if (segments.length === 5 && segments[4] === 'test' && method === 'POST') {
        return await handleTestConnection(req, res, connId, config);
      }

      return apiError(res, 404, 'not_found', 'Route not found.');
    }

    // --- Sessions routes ---
    if (resource === 'sessions') {
      if (segments.length === 3) {
        if (method === 'GET') return await handleListSessions(req, res);
        if (method === 'POST') return await handleCreateSession(req, res, config);
        return apiError(res, 405, 'method_not_allowed', 'Method not allowed.');
      }
      if (segments.length === 4 && segments[3] === 'bootstrap' && method === 'POST') {
        return await handleBootstrapSession(req, res, config);
      }
      if (segments.length === 6 && segments[3] === 'bootstrap' && segments[5] === 'confirm' && method === 'POST') {
        return await handleConfirmAndStartSession(req, res, segments[4], config);
      }
      const sessionId = segments[3];
      if (segments.length === 4) {
        if (method === 'GET') return await handleGetSession(req, res, sessionId, config);
        if (method === 'DELETE') return await handleDeleteSession(req, res, sessionId);
        return apiError(res, 405, 'method_not_allowed', 'Method not allowed.');
      }

      return apiError(res, 404, 'not_found', 'Route not found.');
    }

    // --- Audit routes ---
    if (resource === 'audit') {
      if (segments.length === 3 && method === 'GET') {
        return await handleGetAudit(req, res);
      }
      return apiError(res, 404, 'not_found', 'Route not found.');
    }

    return apiError(res, 404, 'not_found', 'Route not found.');
  } catch (err) {
    console.error('[clawdfather] API error:', (err as Error).message);
    if (!res.headersSent) {
      apiError(res, 500, 'internal_error', 'An unexpected error occurred.');
    }
  }
}
