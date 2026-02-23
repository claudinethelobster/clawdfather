/** Metadata for an active SSH session (in-memory ControlMaster tracking) */
export interface Session {
  sessionId: string;
  keyFingerprint: string;
  targetHost: string;
  targetUser: string;
  targetPort: number;
  controlPath: string;
  connectedAt: number;
  lastActivity: number;
}

/** Result of executing a command over SSH */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Plugin configuration from openclaw.plugin.json */
export interface ClawdfatherConfig {
  sshPort: number;
  webPort: number;
  webDomain: string;
  sessionTimeoutMs: number;
  hostKeyPath?: string;
  allowedOrigins?: string[];
  githubClientId?: string;
  githubClientSecret?: string;
  masterKey?: string;
  databaseUrl?: string;
}

// ── Database-backed model interfaces ────────────────────────────────

export interface Account {
  id: string;
  display_name: string;
  email: string | null;
  created_at: string;
  last_seen_at: string | null;
  is_active: boolean;
}

export interface OAuthIdentity {
  id: string;
  account_id: string;
  provider: string;
  provider_user_id: string;
  provider_username: string | null;
  provider_email: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  scopes: string[] | null;
  created_at: string;
  updated_at: string;
}

export interface AgentKeypair {
  id: string;
  account_id: string;
  label: string;
  algorithm: string;
  public_key: string;
  private_key_enc: string;
  fingerprint: string;
  created_at: string;
  is_active: boolean;
  revoked_at: string | null;
  rotated_at: string | null;
}

export interface SshConnection {
  id: string;
  account_id: string;
  keypair_id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  host_key_fingerprint: string | null;
  last_tested_at: string | null;
  last_test_result: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface SessionLease {
  id: string;
  account_id: string;
  connection_id: string;
  keypair_id: string;
  status: 'pending' | 'active' | 'closed' | 'error';
  agent_session_id: string | null;
  started_at: string | null;
  closed_at: string | null;
  close_reason: string | null;
  last_heartbeat_at: string | null;
  error_detail: string | null;
  created_at: string;
}

export interface AppSession {
  id: string;
  account_id: string;
  token_hash: string;
  device_name: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface AuditLogEntry {
  id: number;
  account_id: string | null;
  actor: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  ip_address: string | null;
  result: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
}
