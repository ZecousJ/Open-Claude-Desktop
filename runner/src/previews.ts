/**
 * Artifact previews on the web (web plan §1.2, W-ARCH §6). The desktop serves
 * a preview from its own `claudex-preview:` scheme; a browser page cannot, and
 * `blob:`/`srcdoc` documents would inherit the web app's strict CSP. So the
 * runner keeps the preview document and Go serves it from
 * `/api/v1/claudex/web/preview/<id>` with the preview's own CSP (`sandbox
 * allow-scripts`, an opaque origin), `Cache-Control: no-store` and
 * `nosniff` (W-RELAY), optionally on the separate content domain (R1-B).
 *
 * - `createArtifactPreview` returns that path. The id is `<userId>.<uuid>`:
 *   the user part lets Go route the request to the runner that holds it,
 *   the UUID (122 random bits) is the capability, as on the desktop. Go may
 *   add its own short-lived `?k=` signature to the path it hands out.
 * - Go reads a document with the runner-internal call `previewDocument(id)`
 *   (never advertised in hello, so browsers cannot call it through `rpc/`),
 *   answered `{content, csp}` or an error for an unknown id.
 * - Limits are the desktop's: 32 MB a document, 16 documents or 96 MB per
 *   user; the documents live in memory and go with the user's context.
 */
import { randomUUID } from "node:crypto";
import {
  ArtifactPreviews,
  maxPreviewBytes,
  previewCsp,
} from "../../electron/artifacts/artifact-previews";
import { webPaths } from "../../shared/web-protocol";

/** The runner-internal call Go uses to read a preview document. */
export const previewDocumentMethod = "previewDocument";

const idPattern =
  /^([1-9][0-9]{0,15})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The user a preview id belongs to; undefined for a malformed id. */
export function previewOwner(id: string): number | undefined {
  const match = idPattern.exec(id);
  return match ? Number(match[1]) : undefined;
}

/** The id at the end of a preview path (query ignored). */
export function previewIdOf(url: string): string | undefined {
  if (!url.startsWith(webPaths.preview)) return undefined;
  const id = url.slice(webPaths.preview.length).split("?")[0]!;
  return idPattern.test(id) ? id : undefined;
}

interface PreviewDocument {
  content: string;
  bytes: number;
  csp: string;
}

/** One user's previews. */
export class WebPreviews extends ArtifactPreviews {
  private docs = new Map<string, PreviewDocument>();
  constructor(private readonly userId: number) {
    super();
  }
  override create(content: string, options: { csp?: string } = {}) {
    const bytes = Buffer.byteLength(content);
    if (bytes > maxPreviewBytes) throw new Error("Preview exceeds 32 MB.");
    const total = [...this.docs.values()].reduce(
      (sum, value) => sum + value.bytes,
      0,
    );
    if (this.docs.size >= 16 || total + bytes > 3 * maxPreviewBytes)
      throw new Error("Too many open previews.");
    const id = `${this.userId}.${randomUUID()}`;
    this.docs.set(id, { content, bytes, csp: options.csp ?? previewCsp });
    return webPaths.preview + id;
  }
  override has(url: string) {
    const id = previewIdOf(url);
    return id !== undefined && this.docs.has(id);
  }
  override release(url: string) {
    const id = previewIdOf(url);
    if (id) this.docs.delete(id);
  }
  override clear() {
    this.docs.clear();
  }
  /** The document Go serves; undefined when it is unknown or released. */
  document(id: string): { content: string; csp: string } | undefined {
    if (previewOwner(id) !== this.userId) return undefined;
    const doc = this.docs.get(id);
    return doc && { content: doc.content, csp: doc.csp };
  }
  override response(url: string, method = "GET") {
    const id = previewIdOf(url);
    const doc = id && method === "GET" ? this.document(id) : undefined;
    if (!doc) return new Response("Preview unavailable", { status: 404 });
    return new Response(doc.content, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": doc.csp,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  get size() {
    return this.docs.size;
  }
}
