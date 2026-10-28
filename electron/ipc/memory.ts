import { z } from "zod";
import { CoworkMemoryFiles } from "../memory/cowork-files";
import { coworkInstructionsLimit } from "../../shared/settings-extras";
import {
  unavailableMemory,
  type MemoryScopeRef,
} from "../../shared/memory-api";
import type { AppContext, IpcHandle } from "../app/app-context";
import { ChatSearchIndex } from "../memory/chat-search";
import { gatewayCompleter } from "../memory/completion";
import { createMemoryExtension, memoryExtensionId } from "../memory/inject";
import { LocalMemoryStore } from "../memory/local-store";
import { RemoteMemoryStore } from "../memory/remote-store";
import {
  MemoryService,
  memoryFocusRefreshMs,
  memoryRefreshMs,
} from "../memory/service";
import { MemoryScheduler } from "../memory/scheduler";
import type { MemoryStore } from "../memory/store";
import { MemorySynthesizer } from "../memory/synthesizer";
import {
  maxImportBytes,
  memoryLimits,
  memoryMessages,
  scopeOf,
  utf8Bytes,
  type MemoryScope,
} from "../memory/types";
import { ClaudexMemory, parseMemoryBootstrap } from "../sub2api/claudex-memory";

const scopeRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }).strict(),
  z
    .object({
      kind: z.literal("project"),
      projectId: z.string().min(1).max(200),
    })
    .strict(),
]);
const prefsInput = z
  .object({ searchChats: z.boolean(), generate: z.boolean() })
  .partial()
  .strict();
// Up to 4 bytes a character; the byte limit is checked after parsing.
const content = z.string().max(memoryLimits.docBytes);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const editId = z.string().min(1).max(64);
// The edit's own length is checked by the service (memoryLimits.editChars).
const editsChange = z
  .object({
    add: z
      .string()
      .max(4 * memoryLimits.editChars)
      .optional(),
    remove: z.array(editId).max(memoryLimits.editsPerScope).optional(),
  })
  .strict();
const importText = z.string().min(1).max(maxImportBytes);

/**
 * The store for the signed-in account: the Claudex service's memory, or
 * memory.json for an account on this computer. An older Sub2API service
 * has no memory.
 */
function storeFor(ctx: AppContext): MemoryStore | undefined {
  const remote = ctx.remote;
  if (!remote) return new LocalMemoryStore(ctx.store.root);
  if (!remote.claudex) return undefined;
  const api = new ClaudexMemory(
    remote.accounts.baseUrl,
    remote.backend.deviceId,
  );
  return new RemoteMemoryStore(
    api,
    (call) => remote.session.authorized(call),
    ctx.store.root,
  );
}

/**
 * Memory (R3, shared/memory-api.ts): Settings → Memory's switches and
 * documents, and the memory the engine gives Chat and Cowork threads.
 *
 * Each signed-in account gets a MemoryService (`ctx.services.memory`); the
 * engine extension (electron/memory/inject.ts) is added to the account's
 * engine and, whatever the account, keeps Codex's own memories off. An
 * account without memory (an older service) reports "unsupported" and
 * refuses every change, so the Settings page shows no memory controls.
 */
export function registerMemoryHandlers(handle: IpcHandle, ctx: AppContext) {
  const files = () => new CoworkMemoryFiles(ctx.store.root);
  const projectFiles = (projectId: string) =>
    new CoworkMemoryFiles(ctx.store.root, projectId);
  const resetFiles = () => {
    const reset = files().reset();
    for (const project of ctx.store.projects) projectFiles(project.id).reset();
    return reset;
  };
  handle(
    "readGlobalMemory",
    () => ctx.store.settings.coworkInstructions ?? null,
  );
  handle("writeGlobalMemory", (raw: unknown) => {
    ctx.store.settings.coworkInstructions = z
      .string()
      .max(coworkInstructionsLimit)
      .parse(raw);
    ctx.store.flush();
    ctx.settingsChanged();
    return true;
  });
  handle("listAccountMemories", (raw?: unknown) =>
    files().list(z.boolean().default(true).parse(raw)),
  );
  handle("readAccountMemory", (raw: unknown) =>
    files().read(z.string().min(1).max(4096).parse(raw)),
  );
  handle("writeAccountMemory", (rawPath: unknown, rawContent: unknown) => {
    const saved = files().write(
      z.string().min(1).max(4096).parse(rawPath),
      z.string().max(262144).parse(rawContent),
    );
    if (saved) ctx.push({ type: "memory-changed" });
    return saved;
  });
  handle("deleteAccountMemory", (raw: unknown) => {
    const removed = files().delete(z.string().min(1).max(4096).parse(raw));
    if (removed) ctx.push({ type: "memory-changed" });
    return removed;
  });
  handle("resetMemories", () => {
    const reset = resetFiles();
    if (reset) ctx.push({ type: "memory-changed" });
    return reset;
  });
  handle("getAutoMemoryDir", (raw: unknown) => {
    const projectId = z
      .string()
      .regex(/^[\w-]+$/)
      .max(200)
      .parse(raw);
    return ctx.store.projects.some((project) => project.id === projectId)
      ? projectFiles(projectId).directory
      : null;
  });
  let stops: (() => void)[] = [];
  let synthesizer: MemorySynthesizer | undefined;
  // The past-chats index reads this computer's conversations as they are.
  const chatIndex = new ChatSearchIndex(() => ctx.store.conversations);
  const service = () => ctx.services.memory?.service;
  const close = () => {
    for (const stop of stops.splice(0)) stop();
    synthesizer = undefined;
    chatIndex.clear();
    ctx.services.memory?.service.close();
    delete ctx.services.memory;
  };
  ctx.onAccountActivated(() => {
    close();
    const engine = ctx.engine;
    engine.capabilityTipMemory = () => service()?.status();
    if (!engine.extensions.has(memoryExtensionId)) {
      const remove = engine.extensions.add(
        createMemoryExtension({
          service,
          search: () => chatIndex,
          accountFiles: (projectId) =>
            [
              files().instructions(),
              projectId &&
              ctx.store.projects.some((project) => project.id === projectId)
                ? projectFiles(projectId).instructions()
                : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
          accountStore: (projectId) =>
            projectId &&
            ctx.store.projects.some((project) => project.id === projectId)
              ? projectFiles(projectId)
              : files(),
        }),
      );
      stops.push(remove);
    }
    let store: MemoryStore | undefined;
    try {
      store = storeFor(ctx);
    } catch (error) {
      console.error(
        "Memory could not be opened:",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!store) return;
    const memory = new MemoryService({
      store,
      policy: () => ctx.policy(),
      changed: () => ctx.push({ type: "memory-changed" }),
    });
    ctx.services.memory = { service: memory };
    stops.push(() => memory.close());
    startSynthesis(memory);
    const remote = ctx.remote;
    if (store.kind === "remote" && remote) {
      // A new bootstrap whose memory section differs (another device wrote).
      stops.push(
        remote.bootstrap.onChange(() => {
          const section = parseMemoryBootstrap(
            remote.bootstrap.rawSection("memory"),
          );
          if (section && memory.differsFrom(section)) void memory.refresh();
        }),
      );
      // Other devices change memory too: read it again now and then.
      const timer = setInterval(() => void memory.refresh(), memoryRefreshMs);
      timer.unref?.();
      stops.push(() => clearInterval(timer));
      stops.push(
        ctx.onWindowFocus(
          () => void memory.refreshIfOlder(memoryFocusRefreshMs),
        ),
      );
    }
  });
  /** The summary task and its schedule for the signed-in account. */
  function startSynthesis(memory: MemoryService) {
    const model = async () => {
      const settings = ctx.store.settings;
      const provider = settings.providers.find(
        (item) => item.id === settings.activeProviderId,
      );
      if (!provider) return undefined;
      const engine = ctx.engine;
      if (!engine.gatewayEndpoint()) {
        try {
          await engine.ensure(provider, { interactive: false });
        } catch {
          return undefined;
        }
      }
      const endpoint = engine.gatewayEndpoint();
      return endpoint
        ? { ...endpoint, model: memory.synthesisModel() ?? provider.model }
        : undefined;
    };
    const task = new MemorySynthesizer({
      service: memory,
      conversations: () => ctx.store.conversations,
      complete: gatewayCompleter(model),
      root: ctx.store.root,
    });
    synthesizer = task;
    const scheduler = new MemoryScheduler({
      enabled: () => memory.effective().generate,
      busy: () => {
        try {
          ctx.noActive();
          return false;
        } catch {
          return true;
        }
      },
      lastAttemptAt: () => task.lastAttemptAt(),
      lastRunFailed: () => task.lastRunFailed(),
      run: () => task.run(),
    });
    scheduler.start();
    // Turning Generate on starts a first summary soon, not tomorrow.
    let wasOn = memory.effective().generate;
    const stopEvents = ctx.onEvent((event) => {
      if (event.type !== "memory-changed") return;
      const on = memory.effective().generate;
      if (on && !wasOn) scheduler.runSoon();
      wasOn = on;
    });
    stops.push(() => {
      stopEvents();
      scheduler.stop();
      task.stop();
    });
  }
  ctx.onAccountDeactivating(() => close());
  ctx.onEvent((event) => {
    if (event.type !== "policy") return;
    const memory = service();
    if (!memory) return;
    // The server works out the switches from the same policy.
    if (memory.store.kind === "remote") void memory.refresh();
    ctx.push({ type: "memory-changed" });
  });

  const required = async () => {
    const memory = service();
    if (!memory) throw new Error(memoryMessages.unsupported);
    await memory.ready();
    return memory;
  };
  /** The scope of a reference; a project must exist and have a usable id. */
  const scopeFrom = (raw: unknown, mustExist: boolean): MemoryScope => {
    const ref = scopeRef.parse(raw) as MemoryScopeRef;
    const scope = scopeOf(ref);
    if (!scope) throw new Error(memoryMessages.noScope);
    if (
      mustExist &&
      ref.kind === "project" &&
      !ctx.store.projects.some((project) => project.id === ref.projectId)
    )
      throw new Error("Project not found.");
    return scope;
  };

  // Settings → Reflect: written from the global memory, kept a day.
  let reflection:
    { source: string; text: string; generatedAt: number } | undefined;
  const reflect = gatewayCompleter(async () => {
    const settings = ctx.store.settings;
    const provider = settings.providers.find(
      (item) => item.id === settings.activeProviderId,
    );
    if (!provider) return undefined;
    if (!ctx.engine.gatewayEndpoint()) {
      try {
        await ctx.engine.ensure(provider, { interactive: false });
      } catch {
        return undefined;
      }
    }
    const endpoint = ctx.engine.gatewayEndpoint();
    return endpoint
      ? {
          ...endpoint,
          model: service()?.synthesisModel() ?? provider.model,
        }
      : undefined;
  });
  handle("memoryReflection", async (raw: unknown) => {
    const refresh = z.boolean().optional().parse(raw) ?? false;
    const memory = service();
    if (!memory) return { state: "off" };
    await memory.ready();
    const status = memory.status();
    if (!status.available || !status.prefs.generate) return { state: "off" };
    const source = status.global?.content.trim() ?? "";
    if (!source) return { state: "empty" };
    if (
      !refresh &&
      reflection?.source === source &&
      Date.now() - reflection.generatedAt < 24 * 60 * 60_000
    )
      return {
        state: "ready",
        text: reflection.text,
        generatedAt: reflection.generatedAt,
      };
    const text = await reflect({
      instructions:
        'You write a short, warm reflection for the user about their recent conversations with Claudex, from the memory notes below. Name the main themes and what they have been working toward, one or two patterns worth noticing, and one gentle suggestion. Speak to the user as "you", in the language the notes mostly use, in at most 180 words of Markdown with a few short paragraphs or a short list. Do not invent facts beyond the notes.',
      input: source,
    });
    reflection = { source, text: text.trim(), generatedAt: Date.now() };
    return {
      state: "ready",
      text: reflection.text,
      generatedAt: reflection.generatedAt,
    };
  });
  handle("memoryStatus", async () => {
    const memory = service();
    if (!memory) return structuredClone(unavailableMemory);
    await memory.ready();
    return memory.status();
  });
  handle("setMemoryPrefs", async (raw: unknown) => {
    const prefs = prefsInput.parse(raw);
    return (await required()).setPrefs(prefs);
  });
  handle("memoryDoc", async (raw: unknown) => {
    const ref = scopeRef.parse(raw) as MemoryScopeRef;
    const scope = scopeOf(ref);
    const memory = service();
    if (!scope || !memory) return null;
    await memory.ready();
    return memory.docView(scope);
  });
  handle(
    "saveMemoryDoc",
    async (rawScope: unknown, rawContent: unknown, rawRevision: unknown) => {
      const scope = scopeFrom(rawScope, true);
      const text = content.parse(rawContent);
      if (utf8Bytes(text) > memoryLimits.docBytes)
        throw new Error(memoryMessages.tooLarge);
      const base = revision.parse(rawRevision);
      return (await required()).saveDoc(scope, text, base, "user");
    },
  );
  handle("removeMemoryEdit", async (raw: unknown) =>
    (await required()).removeEdit(editId.parse(raw)),
  );
  handle("updateMemoryEdits", async (rawScope: unknown, rawChange: unknown) => {
    const scope = scopeFrom(rawScope, true);
    const change = editsChange.parse(rawChange);
    return (await required()).updateEdits(scope, change);
  });
  handle("previewMemoryImport", async (raw: unknown) => {
    const text = importText.parse(raw);
    if (utf8Bytes(text) > maxImportBytes)
      throw new Error("This text is too long to import.");
    await required();
    if (!synthesizer) throw new Error(memoryMessages.unsupported);
    return synthesizer.previewImport(text);
  });
  handle("resetMemory", async (raw?: unknown) => {
    const scope = raw === undefined ? undefined : scopeFrom(raw, false);
    const result = await (await required()).reset(scope);
    if (scope === undefined) resetFiles();
    return result;
  });
}
