import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { TaskBacklog } from "../conversations/task-backlog";
import type { AppContext, IpcHandle } from "../app/app-context";
import type { EngineExtension } from "../engine/engine-extensions";

const id = z.string().min(1).max(500);
const suggestionInput = z
  .object({
    title: z.string().optional(),
    tldr: z.string().optional(),
    prompt: z.string().trim().min(1).max(32000),
    cwd: z.string().trim().min(1).max(4096).optional(),
  })
  .strict();

export function registerTaskBacklogHandlers(
  handle: IpcHandle,
  ctx: AppContext,
) {
  const backlog = () => new TaskBacklog(ctx.store.root);
  const launching = new Set<string>();
  const conversation = (raw: unknown) => {
    const value = ctx.store.conversation(id.parse(raw));
    if (value.mode !== "code" || value.incognito || !value.cwd)
      throw new Error("Open a session to see its background tasks.");
    ctx.allowedFolder(value.cwd, value.environment);
    ctx.services.workspaceTrust?.assert({
      mode: "code",
      conversation: value,
      cwd: value.cwd,
    });
    return value;
  };
  handle("getTaskBacklog", async (raw, count) => {
    const cwd = z.string().min(1).max(4096).parse(raw);
    const limit = z.number().int().min(1).max(20).default(20).parse(count);
    // The home's card asks for whatever folder the draft shows, a remote host's
    // or one not chosen here included: those have no backlog, and the card is
    // no place for a folder-picker notice.
    try {
      ctx.allowedFolder(cwd);
    } catch {
      return [];
    }
    ctx.services.workspaceTrust?.assert({ mode: "code", cwd });
    if (
      !(await fs.stat(cwd).then(
        (entry) => entry.isDirectory(),
        () => false,
      ))
    )
      return [];
    return backlog().list(cwd, limit);
  });
  handle("dismissTaskBacklogItem", (raw, taken) => {
    z.boolean().parse(taken);
    return backlog().dismiss(
      z
        .string()
        .regex(/^todo_[0-9a-f]{12}$/)
        .parse(raw),
    );
  });
  handle(
    "backgroundTaskSuggestions",
    (raw) => conversation(raw).backgroundTaskSuggestions ?? [],
  );
  const pop = (raw: unknown, taskId: string | undefined, launched: unknown) => {
    const value = conversation(raw);
    const taken = z.boolean().parse(launched);
    const queue = value.backgroundTaskSuggestions ?? [];
    const suggestion = taskId
      ? queue.find((entry) => entry.id === taskId)
      : queue[0];
    if (!suggestion || launching.has(`${value.id}:${suggestion.id}`))
      return false;
    if (!taken) backlog().file(value.id, suggestion, "dismissed");
    value.backgroundTaskSuggestions = queue.filter(
      (entry) => entry.id !== suggestion.id,
    );
    ctx.store.flush();
    ctx.push({ type: "conversation", conversation: structuredClone(value) });
    return true;
  };
  handle("popBackgroundTaskSuggestion", (raw, launched) =>
    pop(raw, undefined, launched),
  );
  handle("popBackgroundTaskSuggestionById", (raw, taskId, launched) =>
    pop(raw, id.parse(taskId), launched),
  );
  handle("launchBackgroundTaskSuggestion", async (raw, taskId) => {
    const value = conversation(raw);
    const suggestion = value.backgroundTaskSuggestions?.find(
      (entry) => entry.id === id.parse(taskId),
    );
    if (!suggestion) return null;
    const key = `${value.id}:${suggestion.id}`;
    if (launching.has(key)) return null;
    const root = ctx.store.root;
    ctx.allowedFolder(suggestion.cwd, value.environment);
    ctx.services.workspaceTrust?.assert({
      mode: "code",
      conversation: {
        mode: "code",
        cwd: suggestion.cwd,
        environment: value.environment,
      },
    });
    launching.add(key);
    try {
      const child = await ctx.engine.send({
        text: suggestion.prompt,
        mode: "code",
        cwd: suggestion.cwd,
        environment: value.environment,
        providerId: value.providerId,
        model: value.model,
        attachments: [],
      });
      if (ctx.store.root === root && ctx.store.conversations.includes(value)) {
        value.backgroundTaskSuggestions =
          value.backgroundTaskSuggestions?.filter(
            (entry) => entry.id !== suggestion.id,
          );
        ctx.store.flush();
        ctx.push({
          type: "conversation",
          conversation: structuredClone(value),
        });
      }
      return child.id;
    } finally {
      launching.delete(key);
    }
  });
  const extension: EngineExtension = {
    id: "background-task-suggestions",
    dynamicTools: ({ mode, conversation }) =>
      mode === "code" && !conversation.incognito
        ? [
            {
              type: "function",
              name: "spawn_task",
              description:
                "Flag an out-of-scope issue for a separate background task.\n\nCall this when you notice something worth fixing that would bloat the current change — dead code, stale docs, missing coverage, a confirmed TODO, or a security issue spotted in passing. Don't flag vague code-smell observations, trivial fixes you can do inline, or low-confidence hunches. A chip appears for the user; one click spins it off into its own session. Your current turn continues uninterrupted.\n\nThe prompt must stand alone — include file paths and enough context to act without this conversation.\n\nThe result includes a task_id; call dismiss_task with it if the suggestion later becomes stale.",
              inputSchema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  tldr: { type: "string" },
                  prompt: { type: "string", maxLength: 32000 },
                  cwd: { type: "string" },
                },
                required: ["prompt"],
                additionalProperties: false,
              },
            },
            {
              type: "function",
              name: "dismiss_task",
              description:
                "Withdraw a background-task chip you previously created with spawn_task.\n\nCall this when a suggestion you flagged is now stale, superseded, or irrelevant — e.g. you (or the user) already fixed it in this session, or you spawned a better-scoped replacement. To replace a chip: call spawn_task with the new suggestion first, then dismiss the old task_id.\n\nOnly chips the user hasn't acted on can be withdrawn from the current session. Do not retry if the user already acted on it.",
              inputSchema: {
                type: "object",
                properties: {
                  task_id: { type: "string" },
                  reason: { type: "string" },
                },
                required: ["task_id"],
                additionalProperties: false,
              },
            },
          ]
        : [],
    handleDynamicTool: async (call) => {
      if (call.namespace || !["spawn_task", "dismiss_task"].includes(call.tool))
        return;
      try {
        const value = conversation(call.conversation.id);
        if (call.tool === "dismiss_task") {
          const input = z
            .object({
              task_id: z.string().regex(/^task_[0-9a-f]{8}$/),
              reason: z.string().optional(),
            })
            .strict()
            .parse(call.arguments);
          const queue = value.backgroundTaskSuggestions ?? [];
          if (launching.has(`${value.id}:${input.task_id}`))
            return {
              success: true,
              contentItems: [
                {
                  type: "inputText",
                  text: JSON.stringify({
                    withdrawn: false,
                    task_id: input.task_id,
                  }),
                },
              ],
            };
          const removed = queue.some((entry) => entry.id === input.task_id);
          const filed = backlog().withdraw(value.id, input.task_id);
          if (removed) {
            value.backgroundTaskSuggestions = queue.filter(
              (entry) => entry.id !== input.task_id,
            );
            ctx.store.flush();
            call.changed();
          }
          return {
            success: true,
            contentItems: [
              {
                type: "inputText",
                text: JSON.stringify({
                  withdrawn: removed || filed,
                  task_id: input.task_id,
                }),
              },
            ],
          };
        }
        const input = suggestionInput.parse(call.arguments);
        const cwd = input.cwd ?? value.cwd!;
        if (!path.isAbsolute(cwd)) throw new Error("Folder not found");
        // A folder is checked in the session's own environment: a remote path
        // is neither allowed by the local folders nor present on this disk.
        ctx.allowedFolder(cwd, value.environment);
        ctx.services.workspaceTrust?.assert({
          mode: "code",
          conversation: { mode: "code", cwd, environment: value.environment },
        });
        if (
          (value.environment?.kind ?? "local") === "local" &&
          !(await fs.stat(cwd).then(
            (entry) => entry.isDirectory(),
            () => false,
          ))
        )
          throw new Error("Folder not found");
        const suggestion = {
          title:
            input.title?.trim().slice(0, 200) ||
            input.prompt.split("\n")[0].slice(0, 200),
          tldr: input.tldr?.trim().slice(0, 2000) || undefined,
          prompt: input.prompt,
          id: `task_${randomBytes(4).toString("hex")}`,
          cwd,
          createdAt: Date.now(),
        };
        const queue = [...(value.backgroundTaskSuggestions ?? []), suggestion];
        while (queue.length > 20)
          backlog().file(value.id, queue.shift()!, "evicted");
        value.backgroundTaskSuggestions = queue;
        ctx.store.flush();
        call.changed();
        return {
          success: true,
          contentItems: [
            {
              type: "inputText",
              text: JSON.stringify({
                task_id: suggestion.id,
                position: queue.length,
                pending: queue.map((entry) => ({
                  task_id: entry.id,
                  title: entry.title,
                })),
              }),
            },
          ],
        };
      } catch (error) {
        return {
          success: false,
          contentItems: [{ type: "inputText", text: String(error) }],
        };
      }
    },
  };
  let remove: (() => void) | undefined;
  ctx.onAccountActivated(() => {
    remove?.();
    const engine = ctx.engine;
    const removers = (ctx.engines?.all() ?? [engine]).map((peer) =>
      peer.extensions.add(extension),
    );
    engine.peerExtensions.push(extension);
    remove = () => {
      removers.forEach((remove) => remove());
      engine.peerExtensions = engine.peerExtensions.filter(
        (entry) => entry !== extension,
      );
    };
  });
  ctx.onAccountDeactivating(() => {
    remove?.();
    remove = undefined;
  });
}
