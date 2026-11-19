import fs from "node:fs";
import path from "node:path";
import {
  blankArtifactDirectory,
  resolveBlankArtifactFile,
} from "../artifacts/blank-artifact-files";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppContext, IpcHandle } from "../app/app-context";
import type { Conversation } from "../../shared/types";
import type { ProjectFile } from "../../shared/project-files";
import { artifactOutputKinds } from "../../shared/artifact-output";
import {
  blankArtifactCreateInFlightCode,
  blankArtifactCreateUnconfirmedCode,
  blankArtifactFiles,
  blankArtifactInitialContent,
  type BlankArtifact,
  type BlankArtifactDocument,
  type CreatedBlankArtifact,
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
    retryInFlight: z.literal(true).optional(),
  })
  .strict()
  .refine((input) => !input.retryInFlight || input.kind === "design");
type CreateInput = z.infer<typeof createInput>;
const saveInput = readInput
  .extend({
    content: z.string().max(2_000_000),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
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
function assertCreateModel(store: AppContext["store"], input: CreateInput) {
  const provider = store.settings.providers.find(
    (p) => p.id === input.providerId,
  );
  if (
    !provider ||
    (provider.models.length &&
      ![provider.model, ...provider.models].includes(input.model))
  )
    throw new Error("This account can’t use this model.");
}

function documentFromFile(
  conversationId: string,
  artifact: BlankArtifact,
  file: ProjectFile,
): BlankArtifactDocument {
  if (
    file.content === undefined ||
    !file.revision ||
    file.invalidEncoding ||
    file.binary ||
    file.tooLarge
  )
    throw new Error("This artifact cannot be edited as text.");
  return {
    conversationId,
    artifact: structuredClone(artifact),
    content: file.content,
    revision: file.revision,
    writable: file.writable === true,
  };
}
function readDocument(ctx: AppContext, c: Conversation): BlankArtifactDocument {
  const { directory, artifact } = resolveBlankArtifactFile(
    ctx.engine.defaultWorkspace,
    c,
  );
  return documentFromFile(
    c.id,
    artifact,
    readProjectFile(directory, artifact.file),
  );
}
export function registerBlankArtifactHandlers(
  handle: IpcHandle,
  ctx: AppContext,
) {
  const pending = new WeakMap<
    AppContext["store"],
    Map<
      string,
      { kind: CreateInput["kind"]; result: Promise<CreatedBlankArtifact> }
    >
  >();
  handle("createBlankArtifact", async (raw: unknown) => {
    const input = createInput.parse(raw),
      store = ctx.store;
    if (input.retryInFlight) assertCreateModel(store, input);
    let requests = pending.get(store);
    if (!requests) pending.set(store, (requests = new Map()));
    const previous = requests.get(input.requestId);
    if (previous) {
      if (input.retryInFlight) {
        if (previous.kind !== input.kind) throw fail();
        throw Object.assign(
          new Error("Design creation is still in progress."),
          {
            code: blankArtifactCreateInFlightCode,
          },
        );
      }
      const value = await previous.result;
      if (value.conversation.blankArtifact?.kind !== input.kind) throw fail();
      return value;
    }
    const request = { kind: input.kind, result: create(input) };
    requests.set(input.requestId, request);
    try {
      return await request.result;
    } finally {
      if (requests.get(input.requestId) === request)
        requests.delete(input.requestId);
    }
  });
  async function create(input: CreateInput): Promise<CreatedBlankArtifact> {
    const store = ctx.store,
      engine = ctx.engine;
    async function receipt(c: Conversation): Promise<CreatedBlankArtifact> {
      const current = () =>
        ctx.store === store &&
        ctx.engine === engine &&
        store.conversations.includes(c);
      if (input.retryInFlight) {
        store.assertConversationMetadataWritable(c.id);
        try {
          store.flush();
          await store.confirmConversationMetadata(c, current, true);
        } catch (cause) {
          if (!current()) throw fail();
          store.assertConversationMetadataWritable(c.id);
          readDocument(ctx, c);
          throw Object.assign(
            new Error("Design creation could not be confirmed.", { cause }),
            { code: blankArtifactCreateUnconfirmedCode },
          );
        }
      } else {
        await persist(store);
      }
      if (!current()) throw fail();
      return {
        conversation: structuredClone(c),
        document: readDocument(ctx, c),
      };
    }
    const existing = store.conversations.find((c) => c.id === input.requestId);
    if (existing) {
      if (
        existing.mode !== "chat" ||
        existing.blankArtifact?.kind !== input.kind
      )
        throw fail();
      return receipt(existing);
    }
    if (!input.retryInFlight) assertCreateModel(store, input);
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
      providerId: input.providerId,
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
      const result = await receipt(c);
      ctx.push({ type: "conversation", conversation: result.conversation });
      return result;
    } catch (error) {
      if (
        !input.retryInFlight &&
        !c.turns.length &&
        created &&
        fs.existsSync(file) &&
        fs.readFileSync(file, "utf8") === initial
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
    return readDocument(ctx, c);
  });
  handle("saveBlankArtifact", async (raw: unknown) => {
    const input = saveInput.parse(raw),
      store = ctx.store,
      engine = ctx.engine;
    const c = store.conversation(input.conversationId);
    if (c.blankArtifact?.id !== input.artifactId) throw fail();
    if (c.turns.some((turn) => turn.status === "inProgress"))
      return { status: "denied", reason: "generating" };
    const { directory, artifact, file } = resolveBlankArtifactFile(
      engine.defaultWorkspace,
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
      !store.conversations.includes(c) ||
      c.blankArtifact?.id !== input.artifactId
    )
      throw fail();
    const current = resolveBlankArtifactFile(engine.defaultWorkspace, c);
    if (current.file !== file) throw fail();
    const document = documentFromFile(c.id, current.artifact, result.file);
    ctx.push({ type: "conversation", conversation: structuredClone(c) });
    return { status: "saved", document };
  });
}
