import { ApiRouter } from './api-router';
import { handleHealth } from './routes/health';
import { handleOAuthStart, handleOAuthCallback, handleMe, handleLogout } from './routes/auth';
import { handleListKeys, handleCreateKey, handleGetInstallCommand, handleDefaultInstallCommand, handleRevokeKey } from './routes/keys';
import { handleListConnections, handleCreateConnection, handleUpdateConnection, handleDeleteConnection, handleTestConnection, handleProbe } from './routes/connections';
import { handleListSessions, handleCreateSession, handleDeleteSession } from './routes/sessions';
import { handleBootstrap, handleBootstrapConfirm } from './routes/onboarding';
import { handleListAuditLogs } from './routes/audit';

export function createApiRouter(): ApiRouter {
  const router = new ApiRouter();

  router.add('GET', /^\/api\/v1\/health$/, handleHealth);

  router.add('GET', /^\/api\/v1\/auth\/oauth\/github\/start$/, handleOAuthStart);
  router.add('GET', /^\/api\/v1\/auth\/oauth\/github\/callback$/, handleOAuthCallback);
  router.add('GET', /^\/api\/v1\/auth\/me$/, handleMe);
  router.add('DELETE', /^\/api\/v1\/auth\/session$/, handleLogout);

  router.add('GET', /^\/api\/v1\/keys$/, handleListKeys);
  router.add('POST', /^\/api\/v1\/keys$/, handleCreateKey);
  router.add('GET', /^\/api\/v1\/keys\/default\/install-command$/, handleDefaultInstallCommand);
  router.add('GET', /^\/api\/v1\/keys\/([0-9a-f-]+)\/install-command$/, handleGetInstallCommand);
  router.add('DELETE', /^\/api\/v1\/keys\/([0-9a-f-]+)$/, handleRevokeKey);

  router.add('GET', /^\/api\/v1\/connections$/, handleListConnections);
  router.add('POST', /^\/api\/v1\/connections$/, handleCreateConnection);
  router.add('POST', /^\/api\/v1\/connections\/probe$/, handleProbe);
  router.add('PATCH', /^\/api\/v1\/connections\/([0-9a-f-]+)$/, handleUpdateConnection);
  router.add('DELETE', /^\/api\/v1\/connections\/([0-9a-f-]+)$/, handleDeleteConnection);
  router.add('POST', /^\/api\/v1\/connections\/([0-9a-f-]+)\/test$/, handleTestConnection);

  router.add('GET', /^\/api\/v1\/sessions$/, handleListSessions);
  router.add('POST', /^\/api\/v1\/sessions$/, handleCreateSession);
  router.add('DELETE', /^\/api\/v1\/sessions\/([0-9a-f-]+)$/, handleDeleteSession);

  router.add('POST', /^\/api\/v1\/sessions\/bootstrap$/, handleBootstrap);
  router.add('POST', /^\/api\/v1\/sessions\/bootstrap\/([0-9a-f-]+)\/confirm$/, handleBootstrapConfirm);

  router.add('GET', /^\/api\/v1\/audit$/, handleListAuditLogs);

  return router;
}
