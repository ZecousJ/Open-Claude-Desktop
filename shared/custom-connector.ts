import { isLocalDevHost, isPrivateNetworkHost } from "./browser";

export interface ConnectorOAuthClient {
  clientId?: string;
  clientSecret?: string;
}

// Personal connector form.
export function connectorUrlError(address: string) {
  if (!address.trim()) return "Enter a valid https:// URL";
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return "Enter a valid https:// URL";
  }
  if (
    isLocalDevHost(url.hostname) ||
    isPrivateNetworkHost(url.hostname) ||
    url.hostname === "0.0.0.0"
  )
    return "Claudex can’t reach a local address like this one. Enter a public https:// URL.";
  if (url.protocol !== "https:") return "URL must start with https://";
  if (url.username || url.password || /\$\{/.test(address))
    return "Enter a valid https:// URL";
  return undefined;
}

export function connectorUsesSse(address: string) {
  try {
    return /\/sse\/?$/i.test(new URL(address).pathname);
  } catch {
    return false;
  }
}

export function connectorNameError(name: string, existing: readonly string[]) {
  return existing.some(
    (entry) => entry.toLowerCase() === name.trim().toLowerCase(),
  );
}

export function connectorServerId(name: string, existing: readonly string[]) {
  const base =
    name
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 56) || "connector";
  let candidate = base;
  let suffix = 2;
  while (existing.includes(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}
