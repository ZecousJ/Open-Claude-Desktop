import { createHash } from "node:crypto";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

export function mcpConnectionIdentity(
  servers: Record<string, unknown> | undefined,
) {
  const connections = Object.fromEntries(
    Object.entries(servers ?? {}).map(([name, raw]) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return [name, raw];
      const {
        enabled: _enabled,
        disabled_tools: _disabled,
        tools: _tools,
        ...connection
      } = raw as Record<string, unknown>;
      return [name, connection];
    }),
  );
  return mcpPolicyIdentity(connections);
}

export function mcpPolicyIdentity(
  servers: Record<string, unknown> | undefined,
) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(servers ?? {})))
    .digest("hex");
}
