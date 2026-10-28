import { randomUUID } from "node:crypto";

export const previewCsp =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts";
/** Previews inline their runtime (Mermaid alone is about 5 MB) and binary data. */
export const maxPreviewBytes = 32 * 1024 * 1024;
/**
 * Ephemeral, unguessable documents. No disk paths, network proxying or
 * application IPC. Artifact documents get the sandboxed preview policy; a
 * pop-out's own toolbar page names a stricter one of its own.
 */
export class ArtifactPreviews {
  private documents = new Map<
    string,
    { content: string; bytes: number; csp: string }
  >();
  create(content: string, options: { csp?: string } = {}) {
    const bytes = Buffer.byteLength(content);
    if (bytes > maxPreviewBytes) throw new Error("Preview exceeds 32 MB.");
    const total = [...this.documents.values()].reduce(
      (sum, value) => sum + value.bytes,
      0,
    );
    if (this.documents.size >= 16 || total + bytes > 3 * maxPreviewBytes)
      throw new Error("Too many open previews.");
    const url = `claudex-preview://document/${randomUUID()}`;
    this.documents.set(url, { content, bytes, csp: options.csp ?? previewCsp });
    return url;
  }
  has(url: string) {
    return this.documents.has(url);
  }
  release(url: string) {
    this.documents.delete(url);
  }
  clear() {
    this.documents.clear();
  }
  response(url: string, method = "GET") {
    const document = this.documents.get(url);
    if (!document || method !== "GET")
      return new Response("Preview unavailable", { status: 404 });
    return new Response(document.content, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": document.csp,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
}
