import fs from "node:fs";
import path from "node:path";
import {
  blankArtifactDirectory,
  resolveBlankArtifactFile,
} from "../artifacts/blank-artifact-files";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppContext, IpcHandle } from "../app/app-context";
import type { Conversation } from "../../shared/types";
import type { BlankArtifactDocument } from "../../shared/blank-artifacts";
import { artifactOutputKinds } from "../../shared/artifact-output";
import {
  blankArtifactFiles,
  blankArtifactInitialContent,
} from "../../shared/blank-artifacts";
import { readProjectFile, writeProjectFile } from "../projects/project-files";

const identity = z.string().uuid();
const readInput = z
  .object({ conversationId: identity, artifactId: identity })
  .strict();
const createInput = z
  .object({
    requestId: identity,
    kind: z.enum(artifactOutputKinds),
    name: z.string().trim().min(1).max(200),
    providerId: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
  })
  .strict();
const saveInput = readInput
  .extend({
    content: z.string().max(2_000_000),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const digest = (content: string) =>
  createHash("sha256").update(content).digest("hex");
const fail = () => new Error("The artifact is not available in this account.");
type DurableStore = AppContext["store"] & {
  settled?(): Promise<void>;
  readonly failedWrites?: number;
};
async function persist(store: DurableStore) {
  store.flush();
  await store.settled?.();
  if (store.failedWrites)
    throw new Error("Couldn’t save this artifact. Try again.");
}

function document(ctx: AppContext, c: Conversation): BlankArtifactDocument {
  const { directory, artifact } = resolveBlankArtifactFile(
    ctx.engine.defaultWorkspace,
    c,
  );
  const file = readProjectFile(directory, artifact.file);
  if (
    file.content === undefined ||
    !file.revision ||
    file.invalidEncoding ||
    file.binary ||
    file.tooLarge
  )
    throw new Error("This artifact cannot be edited as text.");
  return {
    conversationId: c.id,
    artifact: structuredClone(artifact),
    content: file.content,
    revision: file.revision,
    writable: file.writable === true,
  };
}
export function registerBlankArtifactHandlers(
  handle: IpcHandle,
  ctx: AppContext,
) {
  const pending = new WeakMap<object, Map<string, Promise<unknown>>>();
  handle("createBlankArtifact", async (raw: unknown) => {
    const input = createInput.parse(raw),
      store = ctx.store;
    let requests = pending.get(store);
    if (!requests) pending.set(store, (requests = new Map()));
    const previous = requests.get(input.requestId);
    if (previous) {
      const value = (await previous) as { conversation: Conversation };
      if (value.conversation.blankArtifact?.kind !== input.kind) throw fail();
      return value;
    }
    const request = create(input);
    requests.set(input.requestId, request);
    try {
      return await request;
    } finally {
      if (requests.get(input.requestId) === request)
        requests.delete(input.requestId);
    }
  });
  async function create(input: z.infer<typeof createInput>) {
    const store = ctx.store,
      engine = ctx.engine;
    const existing = store.conversations.find((c) => c.id === input.requestId);
    if (existing) {
      if (
        existing.mode !== "chat" ||
        existing.blankArtifact?.kind !== input.kind
      )
        throw fail();
      await persist(store);
      if (
        ctx.store !== store ||
        ctx.engine !== engine ||
        !store.conversations.includes(existing)
      )
        throw fail();
      return {
        conversation: structuredClone(existing),
        document: document(ctx, existing),
      };
    }
    const provider = store.settings.providers.find(
      (p) => p.id === input.providerId,
    );
    if (
      !provider ||
      (provider.models.length &&
        ![provider.model, ...provider.models].includes(input.model))
    )
      throw new Error("This account can’t use this model.");
    const directory = blankArtifactDirectory(
      engine.defaultWorkspace,
      input.requestId,
      true,
    );
    const file = path.join(directory, blankArtifactFiles[input.kind]);
    const initial = blankArtifactInitialContent(input.kind);
    let created = false;
    try {
      fs.writeFileSync(file, initial, { flag: "wx", mode: 0o600 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = fs.lstatSync(file);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        fs.realpathSync(file) !== file ||
        fs.readFileSync(file, "utf8") !== initial
      )
        throw fail();
    }
    const now = Date.now();
    const c: Conversation = {
      id: input.requestId,
      title: input.name,
      mode: "chat",
      providerId: provider.id,
      model: input.model,
      cwd: directory,
      environment: engine.environment,
      pinned: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
      turns: [],
      blankArtifact: {
        id: randomUUID(),
        kind: input.kind,
        name: input.kind === "dashboard" ? "Dashboard" : "Untitled",
        file: blankArtifactFiles[input.kind],
        createdAt: now,
      },
    };
    store.conversations.unshift(c);
    try {
      await persist(store);
      if (
        ctx.store !== store ||
        ctx.engine !== engine ||
        !store.conversations.includes(c)
      )
        throw fail();
      const result = {
        conversation: structuredClone(c),
        document: document(ctx, c),
      };
      ctx.push({ type: "conversation", conversation: result.conversation });
      return result;
    } catch (error) {
      // Roll back only our untouched idle creation. Never erase edits or work
      // another window performed while a remote store acknowledgement waited.
      if (
        !c.turns.length &&
        created &&
        fs.existsSync(file) &&
        digest(fs.readFileSync(file, "utf8")) === digest(initial)
      ) {
        store.conversations = store.conversations.filter(
          (entry) => entry !== c,
        );
        fs.unlinkSync(file);
        try {
          fs.rmdirSync(directory);
        } catch {}
        try {
          await persist(store);
        } catch {}
      }
      throw error;
    }
  }
  handle("readBlankArtifact", (raw: unknown) => {
    const input = readInput.parse(raw),
      c = ctx.store.conversation(input.conversationId);
    if (c.blankArtifact?.id !== input.artifactId) throw fail();
    return document(ctx, c);
  });
  handle("saveBlankArtifact", async (raw: unknown) => {
    const input = saveInput.parse(raw),
      store = ctx.store,
      engine = ctx.engine;
    const c = store.conversation(input.conversationId);
    if (c.blankArtifact?.id !== input.artifactId) throw fail();
    if (c.turns.some((turn) => turn.status === "inProgress"))
      return { status: "denied", reason: "generating" };
    const { directory, artifact } = resolveBlankArtifactFile(
      ctx.engine.defaultWorkspace,
      c,
    );
    const result = writeProjectFile(
      directory,
      artifact.file,
      input.content,
      input.expectedRevision,
    );
    if (result.status !== "saved") return result;
    c.updatedAt = Date.now();
    await persist(store);
    if (
      ctx.store !== store ||
      ctx.engine !== engine ||
      !store.conversations.includes(c)
    )
      throw fail();
    ctx.push({ type: "conversation", conversation: structuredClone(c) });
    return { status: "saved", document: document(ctx, c) };
  });
}
