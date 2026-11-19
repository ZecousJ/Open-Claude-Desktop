import { createHash } from "node:crypto";
import { configureUserContentDocument } from "../../electron/official-ui/usercontent";
import { createDocumentPreviewService } from "../../electron/official-ui/document-preview";

/** Pinned resources served by the account-bound document preview host. */
export interface PreviewAsset {
  path: string;
  bytes: Uint8Array;
  sha256: string;
  contentType: string;
}
export interface PreviewIdentity {
  account: string;
  session: string | number;
}

function localOrigin(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
    u.origin !== value ||
    u.username ||
    u.password
  )
    throw Error("Expected an exact loopback origin");
  return u;
}

/** Caller supplies pinned assets, an optional Office converter and a dedicated host. */
export function createIsolatedWebUserContent(options: {
  parentOrigin: string;
  previewOrigin: string;
  identity: PreviewIdentity;
  currentIdentity: () => PreviewIdentity | null;
  assets: readonly PreviewAsset[];
  convertDocument?: (
    data: Buffer,
    extension: string,
    signal: AbortSignal,
  ) => Promise<Buffer>;
}) {
  const parent = localOrigin(options.parentOrigin);
  const preview = localOrigin(options.previewOrigin);
  // Cookies are not port-isolated. A different port on the app host is unsafe.
  if (parent.hostname === preview.hostname)
    throw Error("Preview requires a distinct cookie hostname");
  const owner = { ...options.identity };
  if (!owner.account || !["string", "number"].includes(typeof owner.session))
    throw Error("Missing preview identity");
  const currentIdentity = options.currentIdentity;
  const assets = new Map<string, { bytes: Uint8Array; contentType: string }>();
  let total = 0;
  if (options.assets.length > 2048) throw Error("Preview manifest too large");
  const types = new Set([
    "text/html",
    "text/javascript",
    "text/css",
    "font/woff2",
    "font/woff",
    "font/ttf",
    "font/otf",
    "application/wasm",
  ]);
  for (const a of options.assets) {
    if (
      !/^\/(?:[A-Za-z0-9_./-]*)$/.test(a.path) ||
      a.path.includes("..") ||
      a.path.includes("//") ||
      assets.has(a.path) ||
      !types.has(a.contentType) ||
      (a.contentType === "text/html" && a.path !== "/")
    )
      throw Error("Invalid preview manifest");
    const bytes = Uint8Array.from(a.bytes);
    total += bytes.byteLength;
    if (bytes.byteLength > 16 * 1024 * 1024 || total > 64 * 1024 * 1024)
      throw Error("Preview assets too large");
    if (createHash("sha256").update(bytes).digest("hex") !== a.sha256)
      throw Error("Preview checksum mismatch");
    assets.set(a.path, { bytes, contentType: a.contentType });
  }
  const doc = assets.get("/");
  if (!doc || doc.contentType !== "text/html")
    throw Error("Missing preview document");
  doc.bytes = new TextEncoder().encode(
    configureUserContentDocument(
      new TextDecoder("utf-8", { fatal: true }).decode(doc.bytes),
      parent.origin,
    ),
  );
  let revoked = false;
  const active = () => {
    if (revoked) return false;
    try {
      const current = currentIdentity();
      if (
        current !== null &&
        current.account === owner.account &&
        current.session === owner.session
      )
        return true;
    } catch {
      /* An unavailable identity is never authorization. */
    }
    revoked = true;
    return false;
  };
  const policy = [
    "default-src 'none'",
    "sandbox allow-scripts allow-same-origin",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    options.convertDocument ? "connect-src 'self'" : "connect-src 'none'",
    "worker-src 'none'",
    "frame-src blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${parent.origin}`,
  ].join("; ");
  const headers = {
    "Content-Security-Policy": policy,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  };
  const documents =
    options.convertDocument &&
    createDocumentPreviewService({
      currentSession: () => (active() ? owner : undefined),
      convert: options.convertDocument,
    });
  return {
    issueDocumentPreviewToken() {
      if (!documents) throw Error("Document conversion is unavailable.");
      return documents.issueToken();
    },
    revoke() {
      revoked = true;
    },
    async handle(request: Request): Promise<Response> {
      const fail = (status: number) => new Response(null, { status, headers });
      if (!active()) return fail(410);
      const url = new URL(request.url);
      if (url.origin !== preview.origin || url.username || url.password)
        return fail(403);
      // Never consume auth material even if a prior unrelated local host set it.
      if (request.headers.has("cookie") || request.headers.has("authorization"))
        return fail(403);
      if (url.pathname === "/api/convert-pdf" && documents) {
        if (url.search) return fail(400);
        return documents.handle(request);
      }
      if (!["GET", "HEAD"].includes(request.method)) return fail(403);
      if (
        url.pathname === "/" &&
        (url.searchParams.getAll("parentOrigin").length !== 1 ||
          url.searchParams.get("parentOrigin") !== parent.origin ||
          url.searchParams.getAll("domain").length !== 1 ||
          url.searchParams.get("domain") !== parent.hostname)
      )
        return fail(403);
      const asset = assets.get(url.pathname);
      if (!asset) return fail(404);
      if (!active()) return fail(410);
      return new Response(
        request.method === "HEAD" ? null : Uint8Array.from(asset.bytes),
        { headers: { ...headers, "Content-Type": asset.contentType } },
      );
    },
  };
}
