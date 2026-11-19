import { attachmentKind, builtInAttachmentBytes } from "../../shared/client-policy";
import { officialChatUploadMaxBytes, officialChatUploadOrganization } from "../../shared/official-ui-web";
import type { UploadTransfer } from "../../shared/web-client/codec";
import type { OfficialFrameBindings } from "./frame-lifecycle";

export function createOfficialChatUpload(input: {
  origin: string;
  organization: string;
  signal: AbortSignal;
  action: OfficialFrameBindings["action"];
}) {
  return (address: string, form: FormData, options: Partial<UploadTransfer> = {}) => {
    const url = new URL(address, input.origin);
    const organization = url.origin === input.origin &&
      officialChatUploadOrganization("POST", url.pathname + url.search + url.hash);
    if (!organization) return undefined;
    if (organization !== input.organization)
      return Promise.resolve(Response.json({ error: "Organization not found." }, { status: 404 }));
    const signal = options.signal ? AbortSignal.any([input.signal, options.signal]) : input.signal;
    return send();

    async function send() {
      signal.throwIfAborted();
      const file = form.get("file");
      if (!(file instanceof File))
        return Response.json({ error: "Choose a valid attachment." }, { status: 400 });
      const kind = attachmentKind(file.name.split(".").at(-1) ?? "");
      const oversized = () => Response.json({ error: "The attachment exceeds its file-type size limit." }, { status: 413 });
      if (file.size > builtInAttachmentBytes[kind]) return oversized();
      let partBytes = 0;
      for (const part of form.values()) {
        partBytes += typeof part === "string" ? new TextEncoder().encode(part).length : part.size;
        if (partBytes > officialChatUploadMaxBytes) return oversized();
      }
      const request = new Request(url, { method: "POST", body: form });
      const body = new Uint8Array(await request.arrayBuffer());
      if (body.byteLength > officialChatUploadMaxBytes) return oversized();
      signal.throwIfAborted();
      let abort: (() => void) | undefined;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      });
      try {
        const answer = await Promise.race([input.action({
          method: "POST", path: url.pathname, body,
          contentType: request.headers.get("content-type") ?? "",
        }, { signal, onProgress: options.onProgress, private: form.has("claudex_incognito_draft") }), cancelled]);
        signal.throwIfAborted();
        return new Response(new Uint8Array(answer.body), {
          status: answer.status, headers: { "Content-Type": answer.contentType },
        });
      } finally {
        if (abort) signal.removeEventListener("abort", abort);
      }
    }
  };
}
