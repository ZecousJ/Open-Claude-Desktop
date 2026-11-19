export const mcpAppSandboxPath = "/mcp_apps";

/** Trusted host configuration only; never accept this origin from a conversation or URL parameter. */
export function officialUserContentOrigin(
  value: unknown,
  parentOrigin: string,
): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parent = new URL(parentOrigin),
      preview = new URL(value);
    const loopback = (host: string) =>
      ["localhost", "127.0.0.1", "[::1]"].includes(host);
    if (
      preview.origin !== value ||
      preview.username ||
      preview.password ||
      preview.pathname !== "/" ||
      preview.search ||
      preview.hash ||
      preview.hostname === parent.hostname
    )
      return undefined;
    if (
      preview.protocol !== "https:" &&
      !(
        preview.protocol === "http:" &&
        parent.protocol === "http:" &&
        loopback(preview.hostname) &&
        loopback(parent.hostname)
      )
    )
      return undefined;
    return preview.origin;
  } catch {
    return undefined;
  }
}
