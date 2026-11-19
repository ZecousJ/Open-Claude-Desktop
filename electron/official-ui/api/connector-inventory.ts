/** Keep host-discovered tools while a session's runtime reports a subset.
 * Entries are scoped to one account activation and the server connection;
 * renderer-provided tool definitions never enter this inventory.
 */
import { mcpConnectionIdentity } from "../../../shared/mcp-connection-identity";
import type { McpServerState } from "../../../shared/settings-desktop-api";
import type { AdapterContext } from "./context";
import { toolApprovalMode } from "../../../shared/mcp-tool-approval";

interface InventoryContext {
  settings(): Pick<ReturnType<AdapterContext["settings"]>, "mcpServers">;
  account(): Pick<NonNullable<ReturnType<AdapterContext["account"]>>, "id"> | undefined;
  sessionIdentity?: AdapterContext["sessionIdentity"];
}

type Inventory = {
  tools: NonNullable<McpServerState["toolList"]>;
  refreshed?: true;
};
const inventories = new WeakMap<object, Map<string, Inventory>>();
const inventoryFor = (owner: object) => {
  let inventory = inventories.get(owner);
  if (!inventory) {
    inventory = new Map();
    inventories.set(owner, inventory);
  }
  return inventory;
};
const inventoryOwner = (ctx: InventoryContext) => {
  const identity = ctx.sessionIdentity?.();
  return identity && typeof identity === "object" ? identity : ctx;
};
const inventoryKey = (ctx: InventoryContext, server: McpServerState) =>
  JSON.stringify([
    ctx.account?.()?.id ?? "",
    mcpConnectionIdentity({
      [server.name]: ctx.settings?.().mcpServers?.[server.name] ?? {
        url: server.url,
        command: server.command,
      },
    }),
  ]);

export function readConnectorInventory(
  ctx: InventoryContext,
  servers: McpServerState[],
) {
  const catalog = inventories.get(inventoryOwner(ctx));
  return servers.map((server) => {
    const configured = ctx.settings?.().mcpServers?.[server.name];
    const known =
      catalog?.get(inventoryKey(ctx, server))?.tools ?? server.toolList ?? [];
    const tools = known.map((tool) => {
      if (!configured || typeof configured !== "object") return { ...tool };
      const config = configured as Record<string, unknown>;
      const disabled = Array.isArray(config.disabled_tools)
        ? config.disabled_tools
        : [];
      const { approval: _oldApproval, ...definition } = tool;
      const approval = toolApprovalMode(config, tool.name);
      return {
        ...definition,
        enabled: !disabled.includes(tool.name),
        ...(approval ? { approval } : {}),
      };
    });
    return { ...server, toolList: tools };
  });
}
export function captureConnectorInventoryReset(ctx: AdapterContext, server: McpServerState) {
  const owner = inventoryOwner(ctx), key = inventoryKey(ctx, server);
  return (kind: "refresh" | "remove") => {
    if (kind === "refresh" && ctx.readOnly)
      inventoryFor(owner).set(key, { tools: [], refreshed: true });
    else inventories.get(owner)?.delete(key);
  };
}
export function connectorInventory(
  ctx: InventoryContext,
  servers: McpServerState[],
) {
  const catalog = inventoryFor(inventoryOwner(ctx));
  const liveKeys = new Set<string>();
  for (const server of servers) {
    const fingerprint = inventoryKey(ctx, server);
    liveKeys.add(fingerprint);
    const inventory = catalog.get(fingerprint);
    const known = new Map((inventory?.tools ?? []).map((tool) => [tool.name, tool]));
    for (const tool of server.toolList ?? []) {
      const previous = known.get(tool.name);
      // mcpServerStates adds disabled placeholders without definitions. Keep
      // all proven metadata only for that case, not a new live definition.
      const placeholder =
        !tool.enabled && !tool.description && !tool.definition;
      if (inventory?.refreshed && placeholder && !previous) continue;
      known.set(
        tool.name,
        placeholder && previous
          ? {
              ...previous,
              ...tool,
              description: previous.description,
              definition: previous.definition,
              access: tool.access ?? previous.access,
            }
          : { ...tool },
      );
    }
    catalog.set(fingerprint, { ...inventory, tools: [...known.values()] });
  }
  for (const key of catalog.keys()) if (!liveKeys.has(key)) catalog.delete(key);
  return readConnectorInventory(ctx, servers);
}
