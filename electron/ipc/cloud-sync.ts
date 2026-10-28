import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { projectToolsInput } from "../../shared/project-tools-input";
import {
  maxRolloutBytes,
  rolloutNamePattern,
  type ConversationImported,
} from "../../shared/cloud-sync-api";
import type { Conversation, Project } from "../../shared/types";
import type { AppContext, IpcHandle } from "../app/app-context";
import {
  exportCoworkTask,
  importCoworkTask,
} from "../workspace/cowork-handoff";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const bytes = z.instanceof(Uint8Array);

const importSchema = z.object({
  conversation: bytes.refine((b) => b.byteLength <= 64 * 1024 * 1024),
  project: z
    .object({
      id,
      kind: z.enum(["chat", "local", "code"]).optional(),
      name: z.string().max(500),
      description: z.string().max(20_000),
      instructions: z.string().max(200_000),
      tools: projectToolsInput.optional(),
      icon: z.string().max(100).optional(),
      color: z.string().max(100).optional(),
      defaultModel: z.string().max(500).optional(),
      defaultProviderId: z.string().max(500).optional(),
      defaultEffort: z
        .enum(["low", "medium", "high", "xhigh", "max"])
        .optional(),
      isStarterProject: z.boolean().optional(),
      createdAt: z.number(),
    })
    .optional(),
  rollouts: z
    .array(
      z.object({
        name: z.string().regex(rolloutNamePattern),
        data: bytes.refine((b) => b.byteLength <= maxRolloutBytes),
      }),
    )
    .max(200),
});

/** The fields of a moved conversation that are checked before it is kept. */
const conversationSchema = z
  .object({
    id,
    title: z.string().max(2_000),
    mode: z.enum(["chat", "cowork"]),
    providerId: z.string().max(200),
    model: z.string().max(500),
    createdAt: z.number(),
    updatedAt: z.number(),
    turns: z.array(z.record(z.string(), z.unknown())).max(10_000),
  })
  .passthrough();

/**
 * Moving a desktop conversation to the cloud (shared/cloud-sync-api.ts,
 * docs/cloud-sync.md P5). Only the cloud runner can keep one: the
 * conversation gets its own space (`c-<id>`), the rollouts of its threads go
 * to that space's codex-home, so the next message resumes them there, and it
 * runs in the space's workspace. A conversation the cloud already has is
 * left as it is.
 */
export function registerCloudSyncHandlers(handle: IpcHandle, ctx: AppContext) {
  handle("exportCoworkTask", (raw: unknown, device: unknown) => {
    const owner = z
      .object({
        id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
        name: z.string().min(1).max(80),
      })
      .parse(device);
    const conversation = ctx.store.conversation(id.parse(raw));
    if (
      ctx.scheduler
        ?.list()
        .some((task) => task.conversationId === conversation.id)
    )
      throw new Error(
        "A scheduled task uses this task, so it can’t be linked to a computer.",
      );
    const root =
      conversation.environment?.kind === "space"
        ? ctx.spaceFolder?.(conversation.environment.spaceId)
        : ctx.store.root;
    if (!root) throw new Error("Couldn’t link this task to this computer.");
    if (conversation.linkedToComputer)
      throw new Error(
        "This task was just linked to a different computer, so it wasn’t changed.",
      );
    const payload = exportCoworkTask(
      {
        ...conversation,
        linkedComputerId: owner.id,
        linkedComputerName: owner.name,
      },
      root,
      ctx.store.root,
    );
    conversation.linkedToComputer = true;
    conversation.linkedComputerId = owner.id;
    conversation.linkedComputerName = owner.name;
    ctx.store.flush();
    ctx.push({ type: "conversation", conversation });
    return payload;
  });
  handle("releaseCoworkTask", (raw: unknown) => {
    const conversation = ctx.store.conversation(id.parse(raw));
    if (!ctx.spaceFolder) return;
    conversation.linkedToComputer = false;
    delete conversation.linkedComputerId;
    delete conversation.linkedComputerName;
    ctx.store.flush();
    ctx.push({ type: "conversation", conversation });
  });
  handle("linkCoworkTaskToComputer", (raw: unknown, payload: unknown) => {
    if (ctx.spaceFolder)
      throw new Error("Couldn’t link this task to this computer.");
    const taskId = id.parse(raw);
    const input = importSchema
      .extend({
        files: z
          .array(
            z.object({
              name: z.string().max(4096),
              data: bytes.refine(
                (value) => value.byteLength <= maxRolloutBytes,
              ),
            }),
          )
          .max(2000)
          .optional(),
        blobs: z
          .array(
            z.object({
              name: z.string().regex(/^[0-9a-f]{64}$/),
              data: bytes.refine(
                (value) => value.byteLength <= maxRolloutBytes,
              ),
            }),
          )
          .max(2000)
          .optional(),
      })
      .parse(payload);
    const checked = conversationSchema.parse(
      JSON.parse(Buffer.from(input.conversation).toString("utf8")),
    );
    if (checked.id !== taskId)
      throw new Error("Couldn’t link this task to this computer.");
    const conversation = importCoworkTask(input, ctx.store.root);
    const existing = ctx.store.conversations.findIndex(
      (value) => value.id === taskId,
    );
    if (existing >= 0) ctx.store.conversations[existing] = conversation;
    else ctx.store.conversations.unshift(conversation);
    ctx.store.flush();
    return conversation;
  });
  handle(
    "importConversation",
    async (raw: unknown): Promise<ConversationImported> => {
      if (!ctx.spaceFolder)
        throw new Error(
          "Conversations move to the cloud from the desktop app.",
        );
      const input = importSchema.parse(raw);
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(input.conversation).toString("utf8"));
      } catch {
        throw new Error("The conversation could not be read.");
      }
      const checked = conversationSchema.parse(parsed);
      const store = ctx.store;
      if (store.conversations.some((c) => c.id === checked.id))
        return { id: checked.id, state: "exists" };
      const spaceId = `c-${checked.id}`.slice(0, 80);
      const root = ctx.spaceFolder(spaceId);
      const sessions = path.join(root, "codex-home", "sessions");
      for (const rollout of input.rollouts) {
        const [, year, month, day] = rollout.name.match(rolloutNamePattern)!;
        const folder = path.join(sessions, year, month, day);
        fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
        // Never through a link: the space's folders are the runner's own.
        const file = path.join(folder, rollout.name);
        if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())
          throw new Error("The conversation's history could not be stored.");
        fs.writeFileSync(file, rollout.data, { mode: 0o600 });
      }
      const threads = new Set(
        input.rollouts.map((r) => r.name.match(rolloutNamePattern)![4]),
      );
      const source = checked as unknown as Conversation;
      const conversation: Conversation = {
        ...source,
        // A thread whose history did not come along starts afresh.
        threadId:
          source.threadId && threads.has(source.threadId)
            ? source.threadId
            : undefined,
        cwd: path.join(root, "workspace"),
        environment: { kind: "space", spaceId },
        incognito: undefined,
        slim: undefined,
        turns: source.turns.map((turn) =>
          turn.status === "inProgress"
            ? { ...turn, status: "interrupted" as const }
            : turn,
        ),
      };
      if (!conversation.threadId) delete conversation.threadId;
      delete conversation.incognito;
      delete conversation.slim;
      if (
        input.project &&
        !store.projects.some((p) => p.id === input.project!.id)
      )
        store.projects.push({ ...input.project } as Project);
      if (
        conversation.projectId &&
        !store.projects.some((p) => p.id === conversation.projectId)
      )
        delete conversation.projectId;
      store.conversations.unshift(conversation);
      store.flush();
      ctx.push({ type: "conversation", conversation });
      return { id: conversation.id, state: "imported" };
    },
  );
}
