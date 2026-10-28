// .
const metadataHosts = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
  "instance-data",
  "instance-data.ec2.internal",
  "169.254.169.254",
  "169.254.170.2",
  "169.254.170.23",
  "169.254.0.23",
  "169.254.42.42",
  "100.100.100.200",
  "100.96.0.96",
  "100.80.80.80",
  "168.63.129.16",
  "192.0.0.192",
  "[fd00:ec2::254]",
  "[fd00:ec2::23]",
  "[fd00:a9fe:a9fe::1]",
  "[fe80::a9fe:a9fe]",
]);

export interface PreviewOriginAPI {
  getPreviewAllowedOrigins(): Promise<{ origin: string; builtin: boolean }[]>;
  addPreviewAllowedOrigin(
    origin: string,
    schemeless?: boolean,
  ): Promise<
    "ok" | "invalid" | "loopback" | "exists" | "blocked" | "org-blocked"
  >;
  removePreviewAllowedOrigin(origin: string): Promise<boolean>;
  clearPreviewAllowedOrigins(): Promise<boolean>;
}

export function previewHostname(host: string) {
  let name = host.toLowerCase().replace(/\.+$/, "");
  const mapped = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(name);
  if (mapped) {
    const upper = parseInt(mapped[1], 16);
    const lower = parseInt(mapped[2], 16);
    name = `${upper >> 8}.${upper & 255}.${lower >> 8}.${lower & 255}`;
  }
  return name;
}

export function previewOrigin(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (
      !/^https?:$/.test(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      return undefined;
    let host = previewHostname(parsed.hostname);
    if (
      host.startsWith("www.") &&
      host.split(".").length >= 3 &&
      !host.endsWith(".local")
    )
      host = host.slice(4);
    if (!host || host.startsWith(".")) return undefined;
    return `${parsed.protocol}//${host}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return undefined;
  }
}

export function previewOriginUnsafe(value: string) {
  try {
    const host = previewHostname(new URL(value).hostname);
    return host === "0.0.0.0" || host === "[::]" || metadataHosts.has(host);
  } catch {
    return true;
  }
}
