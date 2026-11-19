const controlPath =
  /^\/v1\/code\/sessions\/(?:session|cse)_([0-9a-f]{32})\/preview-(status|token)$/;

export const codePreviewRelayPath = "/api/v1/claudex/web/code-preview";
export const codePreviewLeaseMethod = "officialCodePreviewLease";
export const codePreviewRequestMethod = "officialCodePreviewRequest";
export const codePreviewHostLabel = /^[1-9][0-9]{0,15}-[0-9a-f]{32}$/;
export const codePreviewRequestBytes = 64 * 1024;
export const codePreviewResponseBytes = 4 * 1024 * 1024;
export const codePreviewRequestHeaders = [
  "accept",
  "accept-language",
  "authorization",
  "content-type",
  "cookie",
  "range",
] as const;

export function codePreviewPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 65535
  );
}

export function officialCodePreviewControl(method: string, path: string) {
  const [pathname, search] = path.split("?", 2);
  const match = controlPath.exec(pathname);
  if (!match) return;
  const [, key, operation] = match;
  if (method === "POST" && operation === "token" && search === undefined)
    return { kind: "token" as const, key };
  if (method !== "GET" || operation !== "status") return;
  const port = Number(/^probe=true&port=([0-9]{1,5})$/.exec(search ?? "")?.[1]);
  if (codePreviewPort(port)) return { kind: "status" as const, key, port };
}

export function codePreviewFrameUrl(
  origin: string,
  token: string,
  path: string,
) {
  if (!codePreviewHostLabel.test(token)) return;
  if (!/^\/(?![\/\\])/.test(path)) return;
  const base = new URL(origin);
  const hostname = base.hostname === "localhost"
    ? `${token}.localhost`
    : `p-${token}.${base.hostname.slice(base.hostname.indexOf(".") + 1)}`;
  base.hostname = hostname;
  if (base.hostname !== hostname) return;
  const target = new URL(path, base);
  if (target.origin === base.origin) return target.href;
}
