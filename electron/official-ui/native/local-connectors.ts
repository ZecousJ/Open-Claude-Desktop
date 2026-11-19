import type { NativeHost } from "./host";
import type { McpServers } from "../../../shared/settings-desktop-api";
import { sessionAccountScope } from "./session-account-scope";
/** Official MCP coordinator returns connected local user configs with tool definitions. */
export function registerLocalConnectors(host: NativeHost) {
  const scope = sessionAccountScope(host.ctx, () => {});
  const read = () =>
    scope.run(async () => {
      if (!host.ctx.account()?.id)
        throw Error("Sign in to read local connectors.");
      if (!host.ctx.localCall)
        throw Error("Local connector inventory is unavailable on this host.");
      const result = (await scope.guard(() =>
        host.ctx.localCall!("mcpServers"),
      )) as McpServers;
      if (!Array.isArray(result?.servers) || result.configError)
        throw Error("Local connector inventory is not available.");
      return result.servers
        .filter((s) => !!s.command && !s.url && s.state === "ready")
        .map((s) => ({
          name: s.name,
          serverSource: "user_config",
          tools: (s.toolList ?? [])
            .filter((t) => t.enabled && t.definition)
            .map((t) => structuredClone(t.definition!)),
        }));
    });
  host.on("LocalSessions.getLocalMcpServers", read);
  host.on("LocalAgentModeSessions.getLocalMcpServers", read);
}
