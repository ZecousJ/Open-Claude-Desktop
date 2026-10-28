export interface EmailLinkRequest {
  request_id: string;
  request_secret: string;
  desktop?: boolean;
}

export interface EmailLink {
  email: string;
  request_id: string;
  code: string;
}

export interface PendingEmailLink extends EmailLinkRequest {
  email: string;
  expiresAt: number;
}

export function parsePendingEmailLink(
  value: string | null,
  now = Date.now(),
): PendingEmailLink | undefined {
  try {
    const pending = JSON.parse(value ?? "null");
    if (
      !pending ||
      !/^[a-f0-9]{64}$/.test(pending.request_id) ||
      !/^[a-f0-9]{64}$/.test(pending.request_secret) ||
      typeof pending.email !== "string" ||
      pending.email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pending.email) ||
      typeof pending.expiresAt !== "number" ||
      pending.expiresAt <= now ||
      pending.expiresAt > now + 600_000
    )
      return;
    return {
      request_id: pending.request_id,
      request_secret: pending.request_secret,
      desktop: false,
      email: pending.email,
      expiresAt: pending.expiresAt,
    };
  } catch {
    return;
  }
}

export function emailLinkRequest(desktop: boolean): EmailLinkRequest {
  const randomKey = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  return { request_id: randomKey(), request_secret: randomKey(), desktop };
}

export function parseEmailLink(href: string): EmailLink | undefined {
  try {
    const url = new URL(href);
    if (
      !(
        url.protocol === "claudex:" &&
        url.hostname === "sign-in" &&
        !url.pathname
      ) &&
      !(
        ["http:", "https:"].includes(url.protocol) &&
        url.pathname === "/sign-in/callback"
      )
    )
      return;
    if (
      url.username ||
      url.password ||
      (url.port && url.protocol === "claudex:")
    )
      return;
    const params = new URLSearchParams(url.hash.slice(1));
    const email = params.get("email") ?? "";
    const request_id = params.get("request_id") ?? "";
    const code = params.get("code") ?? "";
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254 ||
      !/^[a-f0-9]{64}$/.test(request_id) ||
      !/^\d{6}$/.test(code)
    )
      return;
    return { email, request_id, code };
  } catch {
    return;
  }
}
