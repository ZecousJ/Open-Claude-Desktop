export type ExtensionSource = "local.mcpb" | "local.dxt" | "local.unpacked";

export function officialLocalServerName(name: string, value: unknown) {
  if (value && typeof value === "object" &&
      "claudex_extension" in value && "claudex_extension_id" in value &&
      typeof value.claudex_extension_id === "string") return value.claudex_extension_id;
  return name;
}

function originalSlug(value: string) {
  const slug = value.toLowerCase().replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_.]/g, "").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (slug || !value) return slug;
  let hash = 144066263297769815596495629667062367629n;
  const mask = (1n << 128n) - 1n;
  for (let i = 0; i < value.length; i++)
    hash = ((hash ^ BigInt(value.charCodeAt(i))) * 309485009821345068724781371n) & mask;
  return `x${hash.toString(16).padStart(32, "0")}`;
}

export function officialExtensionId(manifest: { name: string; author?: { name?: string } }, source: ExtensionSource) {
  return `${source}.${originalSlug(manifest.author?.name ?? "")}.${originalSlug(manifest.name)}`;
}
