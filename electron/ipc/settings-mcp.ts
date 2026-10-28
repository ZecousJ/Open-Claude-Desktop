import type { McpStdioLogSnapshot } from "../../shared/mcp-stdio-logs";
import { z } from "zod";
import type { AppContext, IpcHandle } from "../app/app-context";
import { mcpEditingRefusal } from "../../shared/client-policy";
import { connectorAllowed } from "../../shared/client-policy-rules";
import { LocalMcpReview } from "../connectors/local-mcp-import";
import { localMcpImportLimit } from "../../shared/settings-mcp-api";

/** Registered per account context, including hosted connection-log reads. */
export function registerMcpSettingsHandlers(
  handle: IpcHandle,
  ctx: AppContext,
  capture?: { read(name: string): McpStdioLogSnapshot },
) {
  const requireLocalEditing = () => {
    if (!ctx.window)
      throw Error("Local MCP discovery is only available in the desktop app.");
    if (!ctx.policy().localMcpEditing)
      throw Error(mcpEditingRefusal(ctx.policy()));
    if (!ctx.mcpConfig) throw Error("Sign in to edit MCP servers.");
  };
  const review = new LocalMcpReview({
    owner: () => ctx.store.root,
    current: () => ctx.store.settings.mcpServers,
    managedNames: () => [...ctx.engine.extensions.reservedMcpServerNames()],
    allowed: (name, config) =>
      ctx.policy().localMcpEditing &&
      connectorAllowed(ctx.policy(), name, config),
    update: (servers) => {
      requireLocalEditing();
      ctx.mcpConfig!.update(servers);
    },
  });
  handle("readMcpLogs", (raw: unknown) => {
    const name = z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/)
      .parse(raw);
    if (
      !Object.hasOwn(ctx.store.settings.mcpServers, name) ||
      !connectorAllowed(ctx.policy(), name, ctx.store.settings.mcpServers[name])
    )
      throw Error("This MCP server is unavailable.");
    const snapshot = ctx.engine.mcpLogs.read(name);
    return capture
      ? { ...snapshot, serverOutput: capture.read(name) }
      : snapshot;
  });
  handle("discoverLocalMcp", () => {
    requireLocalEditing();
    return review.discover();
  });
  handle("importLocalMcp", (raw: unknown) => {
    requireLocalEditing();
    const request = z
      .object({
        token: z.string().uuid(),
        ids: z.array(z.string().uuid()).min(1).max(localMcpImportLimit),
      })
      .strict()
      .parse(raw);
    // Include edits made in the system editor before the debounced file watcher runs.
    ctx.mcpConfig!.reload?.();
    if (ctx.mcpConfig!.error)
      throw Error(
        "The MCP configuration has unapplied changes. Fix it before importing servers.",
      );
    return review.import(request);
  });
}
