/**
 * Clawdfather — OpenClaw Plugin Entry Point
 *
 * Registers:
 *  - Clawdfather as an OpenClaw messaging channel
 *  - SSH server as a background service
 *
 * The agent uses native OpenClaw `exec` tool with SSH ControlMaster
 * prefix for all server commands — no custom tools needed.
 */

import { sessionStore } from "./sessions";
import { startSSHServer } from "./ssh-server";
import { setClawdfatherRuntime } from "./runtime";
import { createClawdfatherChannel } from "./channel";
import type { ClawdfatherConfig } from "./types";
import { loadEnvFile } from "./env";

// Load .env if present
loadEnvFile();

// Resolve plugin root for static UI files
const PLUGIN_ROOT = typeof __dirname !== "undefined"
  ? __dirname.replace(/[/\\]src$/, "").replace(/[/\\]dist$/, "")
  : ".";

export default function register(api: any) {
  // Store runtime for channel use
  setClawdfatherRuntime(api.runtime);

  const pluginConfig = api.config?.plugins?.entries?.clawdfather?.config ?? {};

  const config: ClawdfatherConfig = {
    sshPort: 22,
    webPort: 3000,
    webDomain: "localhost",
    sessionTimeoutMs: 1800000,
    githubClientId: process.env.GITHUB_CLIENT_ID,
    githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
    masterKey: process.env.CLAWDFATHER_MASTER_KEY,
    ...pluginConfig,
  };

  let sshServer: any = null;

  // ── Register as OpenClaw messaging channel ──────────────────────────
  const channelPlugin = createClawdfatherChannel(config, PLUGIN_ROOT);
  api.registerChannel({ plugin: channelPlugin });

  // ── SSH Server background service ───────────────────────────────────
  api.registerService({
    id: "clawdfather-ssh",
    start: () => {
      sessionStore.start(config.sessionTimeoutMs);
      sshServer = startSSHServer(config);
      api.logger.info("[clawdfather] SSH server service started");
    },
    stop: () => {
      sessionStore.stop();
      if (sshServer) {
        sshServer.close();
        sshServer = null;
      }
      api.logger.info("[clawdfather] SSH server service stopped");
    },
  });
}
