import type http from "node:http";
import { z } from "zod";
import { MelangeConflictError, MelangeLimitError, type MelangeFile, type MelangeMode } from "../../memory/melange";
import { officialMelangeRoute, officialMelangeImportBodyBytes, officialMelangeEditBodyBytes } from "../../../shared/official-melange";
import { empty, organizationUuid, reply, type AdapterContext } from "./context";
import { readBoundedJson, RequestBodyError } from "./request-body";

const wirePath = (path: string) => path.startsWith("/") ? path : "/" + path;
const categories = ["topics", "areas", "people", "projects", "preferences"] as const;
const pathInput = z.string().min(1).max(512);
const editInput = z.strictObject({
  instruction: z.string().trim().min(1).max(2000),
  path: pathInput.optional(),
  model: z.string().trim().min(1).max(200).optional(),
});
const pathBody = z.strictObject({ path: pathInput });
const readInput = pathBody.extend({ include_raw: z.boolean().optional() });
const importInput = z.strictObject({ raw_export: z.string().trim().min(1) });

export function melangeFileMetadata(file: MelangeFile) {
  const { path, content, updated_at } = file;
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)?/.exec(content);
  const field = (name: string) => frontmatter?.[1].match(new RegExp("^" + name + ":\\s*(.+)$", "m"))?.[1].trim() ?? "";
  const body = frontmatter ? content.slice(frontmatter[0].length) : content;
  const filename = path.split("/").at(-1)!.replace(/\.md$/i, "").replace(/[-_]/g, " ");
  const name = field("name") || filename;
  const description = field("description");
  const category = path.split("/")[0];
  const category_id = categories.find(id => id === category || `${id}.md` === category) ?? null;
  return {
    path: wirePath(path), updated_at, category_id, description,
    display_name: name,
    memory_id: path,
    parsed: { name, description, body, blocks: [{ scope: category_id ?? "global", text: body }] },
  };
}

export function createMelangeRoute(ctx: AdapterContext) {
  return async (req: http.IncomingMessage, res: http.ServerResponse, pathname: string, url: URL) => {
    const route = officialMelangeRoute(req.method ?? "GET", pathname, url.search);
    if (!route) return false;
    const owner = ctx.account()?.id;
    const identity = ctx.sessionIdentity?.();
    const current = () => !!owner && ctx.account()?.id === owner &&
      ctx.sessionIdentity?.() === identity && ctx.isCurrent?.() !== false;
    const error = (status: number, message: string) =>
      reply(res, { type: "error", error: { type: "invalid_request_error", message } }, status);
    if (!owner || !current()) return error(401, "Sign in to continue.");
    if (route.organization !== organizationUuid(owner)) return error(404, "Organization not found.");
    if (!ctx.melange) return error(501, "This memory mode is unavailable.");
    try {
      const service = await ctx.melange();
      if (!current()) return error(409, "The account changed.");
      if (!service) return error(501, "This memory mode is unavailable.");
      if (route.operation === "external-status" || route.operation === "switch-status") {
        const status = await service.importStatus(route.operation === "external-status" ? "externalImport" : "switchImport");
        return current() ? reply(res, status) : error(409, "The account changed.");
      }
      if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers["content-type"] ?? ""))
        return error(400, "Invalid memory request.");
      const body = await readBoundedJson(req, route.operation === "external-import" ? officialMelangeImportBodyBytes : officialMelangeEditBodyBytes);
      if (!current()) return error(409, "The account changed.");
      if (route.operation === "list") {
        if (!z.strictObject({}).safeParse(body).success) return error(400, "Invalid memory list request.");
        const files = await service.list();
        if (!current()) return error(409, "The account changed.");
        return reply(res, {
          data: files.map(file => {
            const { parsed: _parsed, ...metadata } = melangeFileMetadata(file);
            return metadata;
          }),
          categories: [
            ...categories.map((id, sort_order) => ({ id, sort_order, display_name: id[0].toUpperCase() + id.slice(1) })),
            { id: null, sort_order: categories.length, display_name: "Other" },
          ],
        });
      }
      if (route.operation === "read") {
        const parsed = readInput.safeParse(body);
        if (!parsed.success) return error(400, "Invalid memory read request.");
        const file = await service.readFile(parsed.data.path);
        if (!current()) return error(409, "The account changed.");
        if (!file) return error(404, "Memory file not found.");
        return reply(res, {
          ...melangeFileMetadata(file),
          ...(parsed.data.include_raw === false ? {} : { content: file.content }),
        });
      }
      if (route.operation === "delete") {
        const parsed = pathBody.safeParse(body);
        if (!parsed.success) return error(400, "Invalid memory delete request.");
        const removed = await service.deleteFile(parsed.data.path);
        if (!current()) return error(409, "The account changed.");
        return removed ? empty(res) : error(404, "Memory file not found.");
      }
      if (route.operation === "external-import") {
        const parsed = importInput.safeParse(body);
        if (!parsed.success || Buffer.byteLength(parsed.data.raw_export) > 65_536)
          return error(400, "Invalid memory import.");
        const status = await service.startImport("externalImport", parsed.data.raw_export);
        return current() ? reply(res, status) : error(409, "The account changed.");
      }
      if (route.operation !== "edit") return false;
      const parsed = editInput.safeParse(body);
      if (!parsed.success) {
        if (typeof body.instruction === "string" && body.instruction.trim().length > 2000)
          return reply(res, {
            type: "error", error: { type: "invalid_request_error",
              message: "Memory edit instruction is too long.",
              details: { error_code: "instruction_too_long" } },
          }, 400);
        return error(400, "Invalid memory edit.");
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      const relay = ctx.melangeSignal?.();
      const signal = relay ? AbortSignal.any([controller.signal, relay]) : controller.signal;
      res.once("close", abort);
      const off = ctx.onAccountDeactivating?.(abort);
      try {
        if (res.destroyed || signal.aborted) return true;
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
        const event = (name: string, data: unknown) => {
          if (!signal.aborted && !res.destroyed && current())
            res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        let index = 0;
        const { written, deleted, rejected, text } = await service.edit({
          request: parsed.data.instruction,
          path: parsed.data.path,
          model: parsed.data.model,
          signal,
          onStage: ({ op, path }) => {
            const id = `memory_${index}`;
            event("content_block_start", {
              index, content_block: { type: "tool_use", id, name: `memory_${op}`, memory_op_kind: op },
            });
            if (path) event("content_block_delta", {
              index, delta: { type: "input_json_delta", partial_json: JSON.stringify({ path: wirePath(path) }) },
            });
            event("content_block_stop", { index });
            index++;
          },
        });
        if (text) {
          event("content_block_start", { index, content_block: { type: "text" } });
          event("content_block_delta", { index, delta: { type: "text_delta", text } });
          event("content_block_stop", { index });
        }
        event("melange_edit_result", { written: written.map(wirePath), deleted: deleted.map(wirePath), rejected });
      } catch {
        if (!res.destroyed && !signal.aborted && current())
          res.write('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Memory edit failed."}}\n\n');
      } finally {
        res.removeListener("close", abort);
        off?.();
        if (!res.destroyed) res.end();
      }
      return true;
    } catch (e) {
      if (res.destroyed) return true;
      if (!current()) return error(409, "The account changed.");
      if (e instanceof RequestBodyError) return error(e.status, e.message);
      if (e instanceof MelangeLimitError) return error(413, e.message);
      if (e instanceof MelangeConflictError) return error(409, "Memory changed. Try again.");
      return error(503, "Memory is temporarily unavailable.");
    }
  };
}

export function withMelangeSettings<T extends object>(classic: T, mode: MelangeMode, available: boolean) {
  return { ...classic, memory_mode: mode, enabled_melange: mode === "melange", melange_available: available };
}
