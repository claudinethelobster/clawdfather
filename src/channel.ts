import { getClawdfatherRuntime } from "./runtime";
import { startWebServer, sendToSession } from "./web-server";
import { handleClawdfatherInbound, sanitizeAssistantText } from "./inbound";
import { sessionStore } from "./sessions";
import type { ClawdfatherConfig } from "./types";

const CHANNEL_ID = "clawdfather" as const;

/**
 * Create the Clawdfather channel plugin definition.
 */
export function createClawdfatherChannel(pluginConfig: ClawdfatherConfig, pluginRoot: string) {
  return {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "Clawdfather",
      selectionLabel: "Clawdfather (SSH Admin)",
      blurb: "AI-powered server administration over SSH",
      aliases: ["clawdfather"],
    },
    capabilities: {
      chatTypes: ["direct" as const],
    },
    config: {
      listAccountIds: (cfg: any): string[] => {
        const ch = (cfg.channels as Record<string, any>)?.clawdfather;
        if (ch?.accounts) return Object.keys(ch.accounts);
        return ch?.enabled !== false ? ["default"] : [];
      },
      resolveAccount: (cfg: any, accountId?: string) => {
        const ch = (cfg.channels as Record<string, any>)?.clawdfather;
        const id = accountId ?? "default";
        const acct = ch?.accounts?.[id] ?? {};
        return {
          accountId: id,
          configured: true,
          token: "clawdfather",
          config: acct,
          ...acct,
        };
      },
    },
    outbound: {
      deliveryMode: "direct" as const,
      sendText: async (params: {
        to: string;
        text: string;
        accountId?: string;
        deps?: any;
        replyToId?: string;
        threadId?: string;
        silent?: boolean;
      }) => {
        const sessionId = params.to.replace(`${CHANNEL_ID}:`, "");
        const cleaned = sanitizeAssistantText(params.text);
        if (!cleaned) return { ok: true };
        sendToSession(sessionId, {
          type: "message",
          role: "assistant",
          text: cleaned,
        });
        return { ok: true };
      },
    },
    gateway: {
      startAccount: async (ctx: {
        account: any;
        accountId: string;
        cfg: any;
        runtime: any;
        abortSignal?: AbortSignal;
        log?: { info: (...args: any[]) => void; error?: (...args: any[]) => void };
        setStatus?: (patch: Record<string, any>) => void;
      }) => {
        const accountId = ctx.accountId ?? ctx.account?.accountId ?? "default";

        ctx.log?.info(`[clawdfather] Starting web server for account ${accountId}`);

        const { release } = startWebServer(
          pluginConfig,
          pluginRoot,
          async (sessionId: string, text: string, keyFingerprint: string) => {
            const config = ctx.cfg;
            await handleClawdfatherInbound({
              sessionId,
              text,
              keyFingerprint,
              accountId,
              config,
            });
          }
        );

        return {
          stop: () => {
            release();
            ctx.log?.info("[clawdfather] Web server released for account");
          },
        };
      },
    },
  };
}
