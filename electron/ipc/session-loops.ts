import { z } from "zod";
import type { AppContext, IpcHandle } from "../app/app-context";
import { SessionLoops } from "../engine/session-loops";
import type { EngineExtension } from "../engine/engine-extensions";

const id = z.string().min(1).max(500);
const input = z.object({
  prompt: z.string().trim().min(1).max(200000),
  cron: z.string().min(1).max(200),
  recurring: z.boolean().optional(),
});

// CronCreate/CronDelete/CronList session ownership.
export function registerSessionLoopHandlers(
  handle: IpcHandle,
  ctx: AppContext,
) {
  const loops = new SessionLoops({
    onError: (error) => console.error("Session loop:", error),
    available(conversationId) {
      try {
        const conversation = ctx.store.conversation(conversationId);
        if (conversation.archived || conversation.mode !== "code")
          return "gone";
        return conversation.turns.some((turn) => turn.status === "inProgress")
          ? "busy"
          : "idle";
      } catch {
        return "gone";
      }
    },
    async send(conversationId, prompt) {
      const conversation = ctx.store.conversation(conversationId);
      ctx.services.workspaceTrust?.assert({
        mode: "code",
        conversation,
        cwd: conversation.cwd,
      });
      return ctx.engine.send(
        {
          conversationId,
          text: prompt,
          attachments: [],
          mode: "code",
          providerId: conversation.providerId,
          model: conversation.model,
        },
        undefined,
        false,
        { interactive: false },
      );
    },
  });
  const conversation = (raw: unknown) => {
    const value = ctx.store.conversation(id.parse(raw));
    if (value.mode !== "code" || value.archived)
      throw Error("Open a session to see its background tasks.");
    return value.id;
  };
  handle("listSessionLoops", (raw) => loops.list(conversation(raw)));
  handle("createSessionLoop", (raw, value) =>
    loops.create(conversation(raw), input.parse(value)),
  );
  handle("stopSessionLoop", (raw, loopId) =>
    loops.stop(conversation(raw), id.parse(loopId)),
  );
  const extension: EngineExtension = {
    id: "session-loops",
    dynamicTools: ({ mode }) =>
      mode !== "code"
        ? []
        : [
            {
              type: "function",
              name: "CronCreate",
              description:
                "Schedule a prompt in this session. Use a five-field local-time cron expression. Recurring loops expire after 30 days; recurring false runs once. Only runs while this session host is open, when the session is idle.",
              inputSchema: {
                type: "object",
                properties: {
                  cron: { type: "string" },
                  prompt: { type: "string" },
                  recurring: { type: "boolean" },
                },
                required: ["cron", "prompt"],
                additionalProperties: false,
              },
            },
            {
              type: "function",
              name: "CronList",
              description:
                "List this session's scheduled prompts and recurring loops.",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
            },
            {
              type: "function",
              name: "CronDelete",
              description:
                "Stop this session's scheduled prompt or recurring loop by ID.",
              inputSchema: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
                additionalProperties: false,
              },
            },
          ],
    handleDynamicTool(call) {
      if (!["CronCreate", "CronList", "CronDelete"].includes(call.tool)) return;
      try {
        const conversationId = conversation(call.conversation.id);
        const result =
          call.tool === "CronCreate"
            ? loops.create(conversationId, input.parse(call.arguments))
            : call.tool === "CronDelete"
              ? loops.stop(
                  conversationId,
                  z.object({ id }).parse(call.arguments).id,
                )
              : loops.list(conversationId);
        return {
          success: true,
          contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
        };
      } catch (error) {
        return {
          success: false,
          contentItems: [{ type: "inputText", text: String(error) }],
        };
      }
    },
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let remove: (() => void) | undefined;
  ctx.onAccountActivated(() => {
    remove?.();
    loops.clear();
    const engine = ctx.engine;
    const removers = (ctx.engines?.all() ?? [engine]).map((peer) =>
      peer.extensions.add(extension),
    );
    engine.peerExtensions.push(extension);
    remove = () => {
      for (const remove of removers) remove();
      engine.peerExtensions = engine.peerExtensions.filter(
        (value) => value !== extension,
      );
    };
    if (timer) clearInterval(timer);
    timer = setInterval(
      () =>
        void loops
          .tick()
          .catch((error) => console.error("Session loop:", error)),
      1000,
    );
    timer.unref?.();
  });
  ctx.onAccountDeactivating(() => {
    if (timer) clearInterval(timer);
    remove?.();
    loops.clear();
  });
}
