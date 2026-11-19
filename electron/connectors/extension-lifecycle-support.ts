import { z } from "zod";

export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);

export const valueSchema = z.union([
  z.string().max(8192),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(8192)).max(256),
]);

export const saveSchema = z
  .object({
    id: idSchema,
    revision: z.string().length(64),
    enabled: z.boolean(),
    values: z.record(z.string(), valueSchema),
  })
  .strict();

export const unavailable = "This extension is unavailable.";

export const changed = "The extension changed. Reload it and try again.";

export const configurationUnavailable =
  "Extension configuration is unavailable on this host.";

export const text = (value: unknown, limit = 2048) =>
  typeof value === "string" ? value.slice(0, limit) : undefined;

export const object = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};

export function extensionMcpTemplate(
  manifest: Record<string, any>,
  platform: string = process.platform,
) {
  const base = object(object(manifest.server).mcp_config);
  const override = object(object(base.platform_overrides)[platform]);
  return {
    ...base,
    ...(override.command ? { command: override.command } : {}),
    ...(override.args ? { args: override.args } : {}),
    env: override.env
      ? { ...object(base.env), ...object(override.env) }
      : object(base.env),
  };
}
