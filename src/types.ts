/** Metadata for an active SSH session */
export interface Session {
  /** Unique session identifier */
  sessionId: string;
  /** SSH public key fingerprint of the user */
  keyFingerprint: string;
  /** Target SSH hostname or IP */
  targetHost: string;
  /** Target SSH username */
  targetUser: string;
  /** Target SSH port */
  targetPort: number;
  /** Path to the SSH ControlMaster socket */
  controlPath: string;
  /** Timestamp when session was established */
  connectedAt: number;
  /** Timestamp of last activity */
  lastActivity: number;
}

/** Result of executing a command over SSH */
export interface ExecResult {
  /** Exit code of the command */
  exitCode: number;
  /** Combined stdout output */
  stdout: string;
  /** Combined stderr output */
  stderr: string;
  /** Whether the command timed out */
  timedOut: boolean;
}

/** Plugin configuration from openclaw.plugin.json */
export interface ClawdfatherConfig {
  sshPort: number;
  webPort: number;
  webDomain: string;
  sessionTimeoutMs: number;
  hostKeyPath?: string;
  /** Allowed CORS origins. Empty/undefined = same-origin only. ["*"] = permissive. */
  allowedOrigins?: string[];
  masterKey?: string;
  githubClientId?: string;
  githubClientSecret?: string;
  dbUrl?: string;
}
