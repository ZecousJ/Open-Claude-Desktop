import { createHash } from "node:crypto";
import type http from "node:http";
import type { Conversation, Turn } from "../../../shared/types";
import { maxResearchReportBytes, reportFileName } from "../../../shared/research";
import { organizationUuid, reply, type AdapterContext } from "./context";
import { attachmentResponseHeaders } from "./files";
import { ScopedMap } from "./scope";
import { researchOpaqueId, researchTask, researchTaskId } from "./research-projection";

const limit = maxResearchReportBytes * 2;
const records = new ScopedMap<string, { org: string; conversationId: string; taskId: string; proof: string; name: string; bytes: number }>("research-report-files-v1");
function proof(org: string, c: Conversation, turn: Turn) {
  const taskId = researchTaskId(org, c, turn), r = turn.research?.report;
  if (!taskId || !r || typeof r.title !== "string" || r.title.length > 800 ||
      typeof r.path !== "string" || r.path.length > 600 || !Number.isSafeInteger(r.bytes) ||
      r.bytes < 1 || r.bytes > limit || typeof r.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.sha256)) return;
  return { taskId, key: JSON.stringify([taskId, r.title, r.path, r.bytes, r.sha256]), report: r };
}
export function researchReportAttachment(org: string, c: Conversation, turn: Turn) {
  const r = turn.research?.report, taskId = researchTaskId(org, c, turn);
  if (!r || !taskId) return;
  const checked = proof(org, c, turn);
  const name = reportFileName(typeof r.title === "string" ? r.title : undefined);
  const id = researchOpaqueId(["research-report-v1", taskId, checked?.key ?? "unavailable"]);
  if (checked) {
    records.set(id, { org, conversationId: c.id, taskId, proof: checked.key, name, bytes: r.bytes });
    while (records.size > 10_000) records.delete(records.keys().next().value!);
  }
  return {
    id, fileName: name, path: name, sessionPath: name,
    fileSize: BigInt(checked ? r.bytes : 0), mediaType: "text/markdown", fileKind: 2,
    presentationKind: 1,
    ...(checked ? {
      url: `/api/organizations/${org}/files/${id}/contents`,
      downloadUrl: `/api/organizations/${org}/files/${id}/contents`,
    } : { unavailable: true, unavailableText: "This stored research report has no verified snapshot. Open it in the native Research view." }),
  };
}
export async function researchReportFileRoute(req: http.IncomingMessage, res: http.ServerResponse, p: string, url: URL, ctx: AdapterContext) {
  const match = /^\/api\/(?:organizations\/)?([^/]+)\/files\/([^/]+)\/(contents|preview|thumbnail|content_preview|document_pdf)$/.exec(p);
  if (!match) return false;
  const saved = records.get(match[2]);
  if (!saved) return false;
  const failure = (status: number, message: string) => reply(res, { error: { type: status === 404 ? "not_found_error" : "invalid_request_error", message } }, status);
  if (!["GET", "HEAD"].includes(req.method ?? "") || url.search || req.headers["transfer-encoding"] ||
      (req.headers["content-length"] && req.headers["content-length"] !== "0")) return failure(400, "Unsupported research report request.");
  if (!["contents", "content_preview"].includes(match[3])) return failure(501, "This research report is available as Markdown only.");
  const owner = ctx.account()?.id, activation = ctx.sessionIdentity?.(), root = ctx.stateDirectory?.();
  const current = () => { try { return !!owner && activation != null && ctx.account()?.id === owner && ctx.sessionIdentity?.() === activation &&
    ctx.stateDirectory?.() === root && ctx.isCurrent?.() !== false; } catch { return false; } };
  if (!owner || match[1] !== organizationUuid(owner) || saved.org !== match[1]) return failure(404, "Research report not found.");
  try {
    const owned = async () => {
      if (!current()) throw Error("account");
      const c = await ctx.loadConversation(saved.conversationId);
      if (!current()) throw Error("account");
      if (!c || c.id !== saved.conversationId || c.mode !== "chat" || c.incognito ||
          (c.sessionAuthors?.ownerAccountUuid && c.sessionAuthors.ownerAccountUuid !== owner) ||
          c.turns.length > 10_000 || (c.savedBranches?.length ?? 0) > 199 ||
          (c.savedBranches ?? []).reduce((n, b) => n + b.turns.length, c.turns.length) > 10_000) throw Error("missing");
      const turn = researchTask(saved.org, c, saved.taskId);
      if (!turn) throw Error("missing");
      const value = proof(saved.org, c, turn);
      if (!value || value.key !== saved.proof) throw Error("changed");
      return { turn, report: value.report };
    };
    const { turn, report } = await owned();
    // Copy the expected values before awaiting: a mutable Store reference is not a snapshot.
    const expected = { title: report.title, bytes: report.bytes, sha256: report.sha256 };
    const raw = await ctx.call("readResearchReport", saved.conversationId, turn.id);
    if (!current()) throw Error("account");
    if (!raw || typeof raw !== "object" || !("title" in raw) || raw.title !== expected.title ||
        !("markdown" in raw) || typeof raw.markdown !== "string" || raw.markdown.length > limit) throw Error("corrupt");
    const bytes = Buffer.from(raw.markdown, "utf8");
    if (bytes.length !== expected.bytes || bytes.length > limit || raw.markdown.includes("\0") ||
        createHash("sha256").update(bytes).digest("hex") !== expected.sha256) throw Error("corrupt");
    await owned();
    if (match[3] === "content_preview") {
      if (req.method === "HEAD") { res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(); return true; }
      return reply(res, { content: raw.markdown.slice(0, 20000) });
    }
    const headers = attachmentResponseHeaders({ name: saved.name } as Parameters<typeof attachmentResponseHeaders>[0], "text/markdown; charset=utf-8");
    res.writeHead(200, { ...headers, "Content-Length": String(bytes.length), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(req.method === "HEAD" ? undefined : bytes);
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    const status = !current() || reason === "account" ? 409 : reason === "missing" ? 404 : reason === "changed" ? 409 : 503;
    return failure(status, status === 409 ? "The research report changed. Reopen its conversation." : "The stored research report is unavailable.");
  }
}
