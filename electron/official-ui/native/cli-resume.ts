import { z } from "zod";
import { CliResumeError } from "../../../shared/resume-sessions";
import type { Conversation, Turn } from "../../../shared/types";
import { convertCodeTranscript } from "./code-transcript";
import type { NativeHost } from "./host";
import { sessionAccountScope } from "./session-account-scope";

const handle = z.string().uuid();
const limit = z.number().finite().optional();
const inventory = z.array(
  z.object({
    handle,
    cwd: z.string(),
    title: z.string().optional(),
    gitBranch: z.string().optional(),
    lastActivityAt: z.number(),
    folderMissing: z.boolean().optional(),
    liveness: z.enum(["running", "closed", "unknown"]),
  }),
);
const inspected = z.object({
  permissionMode: z
    .enum(["default", "acceptEdits", "plan", "auto", "bypass"])
    .optional(),
  model: z.string().optional(),
});
const refusal = (error: unknown) =>
  error instanceof CliResumeError ? error.reason : "failed";

export function registerCliResume(host: NativeHost) {
  const { ctx } = host;
  const scope = sessionAccountScope(ctx, () => {});
  const available = () =>
    !!ctx.account()?.id &&
    !ctx.readOnly &&
    !!ctx.localCall &&
    ctx.isCurrent?.() !== false;
  const call = (method: string, ...args: unknown[]) =>
    scope.run(async () => {
      if (!available())
        throw Error("CLI session discovery is unavailable on this host.");
      const result = await scope.guard(() => ctx.localCall!(method, ...args));
      if (ctx.isCurrent?.() === false)
        throw Error("The account changed during this request.");
      return result;
    });
  const list = async (
    method: string,
    raw: unknown,
    fallback: number,
    max: number,
  ) => {
    const count = Math.max(
      1,
      Math.min(max, Math.floor(limit.parse(raw) ?? fallback)),
    );
    return inventory
      .parse(await call(method))
      .slice(0, count)
      .map((row) => ({
        ...row,
        liveness: row.liveness === "closed" ? "not_running" : row.liveness,
      }));
  };
  host.on("LocalSessions.listCliSessions", () => []);
  host.on("LocalSessions.listResumableCliSessions", (raw?: unknown) =>
    list("listResumableSessions", raw, 1000, 1000),
  );
  host.on("LocalSessions.openCliTail", () => false);
  host.on("LocalSessions.closeCliTail", () => true);
  host.on(
    "LocalSessions.readCliTranscript",
    async (raw: unknown, offset?: unknown, rawLimit?: unknown) => {
      const id = handle.parse(raw);
      const start = Math.max(0, Math.floor(limit.parse(offset) ?? 0));
      const count = Math.max(
        1,
        Math.min(5000, Math.floor(limit.parse(rawLimit) ?? 2000)),
      );
      const turns = (await call("previewResumeSession", id)) as Turn[];
      const sessionId = `cli-${id}`;
      const { rows } = convertCodeTranscript({
        id: sessionId,
        mode: "code",
        turns,
        title: "",
        providerId: "",
        model: "",
        pinned: false,
        archived: false,
        createdAt: 0,
        updatedAt: 0,
      });
      return {
        messages: rows.slice(start, start + count),
        totalMessages: rows.length,
      };
    },
  );
  host.on("LocalSessions.previewCliResume", async (raw: unknown) => {
    try {
      const { permissionMode, model } = inspected.parse(
        await call("inspectResumableSession", handle.parse(raw)),
      );
      return {
        resumable: true,
        ...(permissionMode && {
          permissionMode:
            permissionMode === "bypass" ? "bypassPermissions" : permissionMode,
        }),
        ...(model && { model }),
      };
    } catch (error) {
      return { resumable: false, reason: refusal(error) };
    }
  });
  host.on("LocalSessions.resumeCliSession", async (raw: unknown) => {
    try {
      const conversation = (await call(
        "resumeSession",
        handle.parse(raw),
      )) as Conversation;
      const id = handle.parse(conversation.id);
      host.emit("LocalSessions", "onEvent", {
        type: "importable_cli_sessions_changed",
      });
      return { ok: true, sessionId: `local_${id}` };
    } catch (error) {
      return { ok: false, reason: refusal(error) };
    }
  });
}
