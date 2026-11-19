import { conversationSnippets } from "../api/artifacts";
import type { AdapterContext } from "../api/context";

const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface StaticArtifactSelection {
  conversationId: string;
  artifactId: string;
  versionId: string;
}
export function parseStaticArtifactSelection(
  raw: unknown,
): StaticArtifactSelection {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error("Invalid artifact selection.");
  const value = raw as Record<string, unknown>;
  if (
    Object.keys(value).length !== 3 ||
    typeof value.conversationId !== "string" ||
    !value.conversationId ||
    value.conversationId.length > 200 ||
    typeof value.artifactId !== "string" ||
    !id.test(value.artifactId) ||
    typeof value.versionId !== "string" ||
    !id.test(value.versionId)
  )
    throw Error("Invalid artifact selection.");
  return {
    conversationId: value.conversationId,
    artifactId: value.artifactId,
    versionId: value.versionId,
  };
}
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
/** No sanitization claim: sandbox, CSP AND native deny-network/navigation are mandatory. */
export function staticArtifactDocument(content: string, type: string): string {
  if (
    typeof content !== "string" ||
    Buffer.byteLength(content) > 1024 * 1024 ||
    content.includes("\0")
  )
    throw Error("Static artifact is too large or invalid.");
  if (!["text/html", "text/plain", "text/markdown"].includes(type))
    throw Error(
      "This artifact needs an interactive renderer; static preview is unavailable.",
    );
  const body = type === "text/html" ? content : `<pre>${escape(content)}</pre>`;
  // First policy cannot be relaxed by a later artifact-supplied meta tag.
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; worker-src 'none'\"></head><body>" +
    body +
    "</body></html>"
  );
}
/** Reads an existing owned conversation; renderer paths/content are never authoritative. */
export async function readStaticArtifact(ctx: AdapterContext, raw: unknown) {
  const selected = parseStaticArtifactSelection(raw);
  const owner = ctx.account()?.id,
    activation = ctx.sessionIdentity?.(),
    stateDirectory = ctx.stateDirectory?.();
  if (!owner || activation == null || activation === "")
    throw Error("Static preview requires an active account.");
  const current = () => {
    try {
      return (
        ctx.isCurrent?.() !== false &&
        ctx.account()?.id === owner &&
        ctx.sessionIdentity?.() === activation &&
        ctx.stateDirectory?.() === stateDirectory
      );
    } catch {
      return false;
    }
  };
  if (!current()) throw Error("The preview account changed.");
  const conversation = await ctx.loadConversation(selected.conversationId);
  if (!current()) throw Error("The preview account changed.");
  if (!conversation || conversation.id !== selected.conversationId)
    throw Error("Artifact source is unavailable.");
  const snippet = conversationSnippets(owner, conversation).find(
    (row) =>
      row.artifact_uuid === selected.artifactId &&
      row.uuid === selected.versionId,
  );
  if (!snippet) throw Error("Artifact version is unavailable.");
  const document = staticArtifactDocument(
    snippet.result_state,
    snippet.artifact_type,
  );
  if (!current()) throw Error("The preview account changed.");
  return { document, current };
}
