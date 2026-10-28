import { starterConnectorId } from "../../shared/starter-integrations";
import { z } from "zod";
import { settingsRefusal } from "../../shared/client-policy";
import { notAvailableOnWeb } from "../../shared/web-bridge-methods";
import { type AppWindows } from "../../electron/app/app-context";
import { DesktopIntegration } from "../../electron/app/desktop-integration";
import { desktopPreferenceFields } from "../../electron/store/settings-preferences";
import type { McpConfigLike } from "../../electron/app/app-context";
import { validToolsTable } from "../../shared/mcp-tool-approval";
import type { WebAppContext } from "./web-app-context";

/** The user-API answer that identifies a user (`GET /auth/me`). */
export interface Me {
  id: number;
  email: string;
  username?: string;
}

const providerSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  baseUrl: z.string().max(2000),
  protocol: z.enum(["responses", "chat"]),
  model: z.string().max(200),
  models: z.array(z.string().max(200)).max(2000),
  transcriptionModel: z.string().min(1).max(200).optional(),
  hasApiKey: z.boolean().optional(),
});

/** main.ts's settings schema; folders and MCP servers are kept from the store. */
export const settingsSchema = z.object({
  theme: z.enum(["light", "dark", "system"]),
  sidebarWidth: z.number().int().min(188).max(460),
  name: z.string().max(100),
  providers: z.array(providerSchema).min(1).max(30),
  activeProviderId: z.string(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
  codeEffort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]),
  sandbox: z.enum(["read-only", "workspace-write"]),
  codeSandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]),
  bypassFolders: z.array(z.string().max(4096)).max(500).optional(),
  autoAcceptEdits: z.boolean(),
  codePlanMode: z.boolean(),
  instructions: z.string().max(100000),
  mcpServers: z.record(z.string(), z.unknown()),
  chatFont: z.enum(["serif", "sans", "system", "dyslexia"]).optional(),
  motion: z.enum(["system", "reduced"]).optional(),
  codeFont: z
    .string()
    .max(200)
    .regex(/^[^;{}<>\\]*$/, "Use a font family name.")
    .optional(),
  hiddenNavItems: z
    .array(z.enum(["projects", "artifacts", "scheduled", "customize"]))
    .max(8)
    .optional(),
  ...desktopPreferenceFields("linux"),
});

export const idString = z.string().min(1).max(500);

/** No window on the web: every member answers "none". */
export const noWindows: AppWindows = {
  main: () => undefined,
  all: () => [],
  roleOf: () => undefined,
  focused: () => undefined,
  register: () => {
    throw new Error(notAvailableOnWeb);
  },
  webPreferences: () => {
    throw new Error(notAvailableOnWeb);
  },
  load: async () => {
    throw new Error(notAvailableOnWeb);
  },
  send: () => {},
  closeConversationWindows: () => {},
};

/** Desktop integration with nothing to integrate with (no tray, no shortcuts). */
export class NoIntegration extends DesktopIntegration {
  constructor() {
    super({
      window: () => undefined,
      settings: () => undefined,
      conversations: () => [],
      command: () => {},
      trayIcon: "",
    });
  }
  override start() {}
  override apply() {}
  override reset() {}
  override observeConversation() {}
  override observeApproval() {}
  override observeSchedules() {}
  override connectWindows() {}
}

/**
 * The MCP configuration of a web user: no file, only remote https servers.
 * Every change goes through the administrator's policy, is saved with the
 * user's settings and restarts the agent once it is idle so the servers it
 * offers follow. Tokens of connectors that are gone are forgotten.
 */
export class WebMcpConfig implements McpConfigLike {
  readonly path = "";
  error?: string;
  private restart?: NodeJS.Timeout;
  constructor(private readonly ctx: WebAppContext) {}
  ensure() {}
  update(servers: Record<string, unknown>) {
    const ctx = this.ctx;
    const before = ctx.store.settings.mcpServers;
    const clean: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(servers)) {
      const server = entry as Record<string, unknown> | null;
      if (
        server &&
        typeof server === "object" &&
        typeof server.url === "string" &&
        server.url.startsWith("https://")
      ) {
        const kept: Record<string, unknown> = { url: server.url };
        const connectorId = starterConnectorId(server.connector_id);
        if (connectorId) kept.connector_id = connectorId;
        if (server.display_name !== undefined)
          kept.display_name = z
            .string()
            .trim()
            .min(1)
            .max(128)
            .parse(server.display_name);
        if (server.claudex_transport !== undefined)
          kept.claudex_transport = z
            .enum(["sse", "streamable-http"])
            .parse(server.claudex_transport);
        for (const key of [
          "enabled",
          "disabled_tools",
          "startup_timeout_sec",
          "tool_timeout_sec",
        ])
          if (key in server) kept[key] = server[key];
        // Per-tool approval modes (Always allow / Needs approval): only an
        // approval_mode of "approve" or "prompt", nothing else of Codex's table.
        if ("tools" in server) {
          if (!validToolsTable(server.tools))
            throw new Error("The connector's tool permissions are not valid.");
          if (Object.keys(server.tools).length) kept.tools = server.tools;
        }
        clean[name] = kept;
      } else if (JSON.stringify(before[name]) === JSON.stringify(entry))
        clean[name] = entry;
      else throw new Error("Only remote https connectors can be used here.");
    }
    const refusal = settingsRefusal(
      ctx.store.settings,
      { ...ctx.store.settings, mcpServers: clean },
      ctx.policy(),
    );
    if (refusal) throw new Error(refusal);
    for (const [name, server] of Object.entries(clean)) {
      const previousUrl = (before[name] as { url?: string } | undefined)?.url;
      if (previousUrl && previousUrl !== (server as { url?: string }).url)
        ctx.connectorTokens.set(name, undefined);
    }
    ctx.store.settings.mcpServers = clean;
    ctx.store.flush();
    ctx.connectorTokens.keepOnly(Object.keys(clean));
    ctx.settingsChanged();
    this.restartWhenIdle();
  }
  /** The agent restarts with the new servers once no turn is running. */
  private restartWhenIdle() {
    clearTimeout(this.restart);
    const attempt = () => {
      this.restart = undefined;
      if (this.ctx.closed || !this.ctx.engineRunning()) return;
      if (this.ctx.busy()) {
        this.restart = setTimeout(attempt, 2000);
        this.restart.unref?.();
        return;
      }
      void this.ctx.stopEngine().catch(() => {});
    };
    this.restart = setTimeout(attempt, 0);
    this.restart.unref?.();
  }
}
