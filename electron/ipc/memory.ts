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
import { existingMelangeForAccount, ownsMemoryProject, readyMelangeForAccount } from "../memory/melange-host";
import { RemoteMemoryStore } from "../memory/remote-store";
import {
  MemoryService,
  memoryFocusRefreshMs,
  memoryRefreshMs,
} from "../memory/service";
import { MemoryScheduler } from "../memory/scheduler";
import { startMemorySearch } from "../memory/search-mcp";
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
  const store = ctx.store, owner = ctx.activeAccount?.id, generation = ctx.accountActivationIdentity, session = remote.session;
  return new RemoteMemoryStore(
    api,
    (call, current) => session.authorized(call, () =>
      !ctx.accountRetiring && ctx.store === store && ctx.remote === remote && remote.session === session &&
      ctx.activeAccount?.id === owner && ctx.accountActivationIdentity === generation && (!current || current())),
    store.root,
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
  const deviceFiles = () => {
    if (ctx.coworkAccountMemory) throw Error("Use the hosted Cowork memory controls.");
    return files();
  };
  const strictInput = z.object({ strict: z.boolean().optional() }).strict().optional();
  const resetFiles = (strict = false, store = ctx.store) => {
    const account = ctx.coworkAccountMemory ? undefined : new CoworkMemoryFiles(store.root);
    const projects = store.projects.map(project => new CoworkMemoryFiles(store.root, project.id));
    if (strict) {
      const stores = account ? [account, ...projects] : projects;
      for (const store of stores) store.assertResettable();
      try {
        for (const store of stores) if (!store.reset(true)) throw Error("Memory reset was refused.");
        return true;
      } catch (error) { throw Error("Memory reset was incomplete; some files may already have been removed.", { cause: error }); }
    }
    const reset = account?.reset() ?? true;
    for (const project of projects) project.reset();
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
  handle("listAccountMemories", (raw?: unknown, options?: unknown) =>
    deviceFiles().list(z.boolean().default(true).parse(raw), strictInput.parse(options)?.strict),
  );
  handle("readAccountMemory", (raw: unknown, options?: unknown) =>
    deviceFiles().read(z.string().min(1).max(4096).parse(raw), strictInput.parse(options)?.strict),
  );
  handle("writeAccountMemory", (rawPath: unknown, rawContent: unknown) => {
    const saved = deviceFiles().write(
      z.string().min(1).max(4096).parse(rawPath),
      z.string().max(262144).parse(rawContent),
    );
    if (saved) ctx.push({ type: "memory-changed" });
    return saved;
  });
  handle("deleteAccountMemory", (raw: unknown) => {
    const removed = deviceFiles().delete(z.string().min(1).max(4096).parse(raw));
    if (removed) ctx.push({ type: "memory-changed" });
    return removed;
  });
  handle("resetMemories", (options?: unknown) => {
    if (ctx.coworkAccountMemory) throw Error("Use the hosted Cowork memory controls.");
    const reset = resetFiles(strictInput.parse(options)?.strict);
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
  let searchTransport: ReturnType<typeof startMemorySearch> | undefined;
  const service = () => ctx.services.memory?.service;
  const close = () => {
    for (const stop of stops.splice(0)) stop();
    synthesizer = undefined;
    ctx.services.memory?.service.close();
    delete ctx.services.memory;
    const search = searchTransport;
    searchTransport = undefined;
    return search?.close();
  };
  const prepareMemory = () => {
    void close();
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
  };
  ctx.onAccountPrepared?.(prepareMemory);
  ctx.onAccountActivated(() => {
    if (!ctx.onAccountPrepared) prepareMemory();
    const engine = ctx.engine;
    const melange = ctx.remote?.claudex ? async () => {
      const memory = service();
      await memory?.ready();
      if (!memory || memory !== service()) return undefined;
      return existingMelangeForAccount(ctx) ?? await readyMelangeForAccount(ctx);
    } : undefined;
    engine.capabilityTipMemory = () => service()?.status();
    if (!engine.extensions.has(memoryExtensionId)) {
      const ownerStore = ctx.store;
      const owner = ctx.activeAccount?.id;
      const activation = ctx.accountActivationIdentity;
      const current = () =>
        !ctx.accountRetiring &&
        ctx.store === ownerStore &&
        ctx.activeAccount?.id === owner &&
        ctx.accountActivationIdentity === activation;
      const accountService = () => (current() ? service() : undefined);
      const coworkAccountMemory = ctx.coworkAccountMemory;
      const ownedProject = (id?: string) =>
        id && ownerStore.projects.some(project => project.id === id) ? id : undefined;
      const chatIndex = new ChatSearchIndex(() => ownerStore.conversations);
      searchTransport = startMemorySearch({
        service: accountService,
        conversation: (id) => current()
          ? ownerStore.conversations.find((conversation) => conversation.id === id)
          : undefined,
        index: chatIndex,
      });
      const extension = createMemoryExtension({
        service: accountService,
        melange,
        coworkAccountMemory,
        search: () => chatIndex,
        searchTransport,
        accountFiles: (projectId) => {
          const project = ownedProject(projectId);
          return [
            !coworkAccountMemory && new CoworkMemoryFiles(ownerStore.root).instructions(),
            project && new CoworkMemoryFiles(ownerStore.root, project).instructions(),
          ].filter(Boolean).join("\n\n");
        },
        accountStore: (projectId) => {
          const project = ownedProject(projectId);
          if (project || !coworkAccountMemory) return new CoworkMemoryFiles(ownerStore.root, project);
        },
      });
      const remove = engine.extensions.add(extension);
      engine.peerExtensions.push(extension);
      stops.push(() => {
        remove();
        const index = engine.peerExtensions.indexOf(extension);
        if (index >= 0) engine.peerExtensions.splice(index, 1);
      });
    }
    const memory = service();
    if (!memory) return;
    startSynthesis(memory, melange);
    const remote = ctx.remote;
    if (memory.store.kind === "remote" && remote) {
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
  function startSynthesis(memory: MemoryService, melange?: () => ReturnType<typeof readyMelangeForAccount>) {
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
      melange,
      ownsScope: (scope) => scope === "global" || ctx.store.projects.some(project =>
        `project:${project.id.toLowerCase()}` === scope && !ctx.store.isProjectDeleting(project.id),
      ),
    });
    synthesizer = task;
    const scheduler = new MemoryScheduler({
      enabled: () => {
        const { available, allowed } = memory.status();
        return memory.effective().generate || (!!melange && available && allowed.generate);
      },
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
    if (ctx.services.memory?.service === memory)
      ctx.services.memory.onMelangeEnabled = () => scheduler.runSoon();
    scheduler.start();
    // Turning Generate on starts a first summary soon, not tomorrow.
    let wasOn = memory.effective().generate;
    const stopEvents = ctx.onEvent((event) => {
      if (event.type !== "memory-changed") return;
      const on = memory.effective().generate;
      if (on && !wasOn) scheduler.runSoon();
      else if (!on && wasOn) task.cancelClassic();
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
    if (service() !== memory) throw new Error("Memory account changed.");
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
      !ownsMemoryProject(ctx, ref.projectId)
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
  const snapshotRead = z.object({snapshotOnly:z.literal(true)}).strict().optional();
  const controlsRead = z.union([
    snapshotRead.unwrap(),
    z.strictObject({ fresh: z.literal(true) }),
  ]).optional();
  // A service can survive briefly while an account retires or is reactivated.
  // Pin every read to the whole activation, not just the service object, and
  // check again after each asynchronous boundary before returning private data.
  const memoryRead = () => {
    const memory = service(), store = ctx.store, remote = ctx.remote;
    const session = remote?.session, owner = ctx.activeAccount?.id;
    const generation = ctx.accountActivationIdentity;
    const check = () => {
      if (ctx.accountRetiring || service() !== memory || ctx.store !== store ||
          ctx.remote !== remote || ctx.remote?.session !== session ||
          ctx.activeAccount?.id !== owner || ctx.accountActivationIdentity !== generation)
        throw new Error("Memory account changed.");
    };
    check();
    return { memory, check };
  };
  handle("memoryStatus", async (options?: unknown) => {
    const snapshot = snapshotRead.parse(options);
    const { memory, check } = memoryRead();
    if (!memory) return structuredClone(unavailableMemory);
    if (snapshot) {
      const status = memory.status();
      if (status.reason === "offline") throw Error(memoryMessages.offline);
      return status;
    }
    await memory.ready();
    check();
    return memory.status();
  });
  handle("setMemoryPrefs", async (raw: unknown, options?: unknown) => {
    const mode = z.object({disableOnly:z.literal(true)}).strict().optional().parse(options);
    const prefs = mode ? z.object({generate:z.literal(false)}).strict().parse(raw) : prefsInput.parse(raw);
    const { memory, check } = memoryRead();
    if (!memory) throw Error(memoryMessages.unsupported);
    // General switch writes need the same activation lease as disable-only.
    // Keep disable-only inert: no readiness wait, refresh or implicit recovery.
    if (!mode) {
      await memory.ready();
      check();
    }
    const status = await memory.setPrefs(prefs, mode);
    check();
    return status;
  });
  handle("memoryDoc", async (raw: unknown) => {
    const scope = scopeFrom(raw, true);
    const { memory, check } = memoryRead();
    if (!memory) return null;
    await memory.ready();
    check();
    scopeFrom(raw, true);
    await memory.refresh();
    check();
    scopeFrom(raw, true);
    return memory.docView(scope);
  });
  handle("memoryControlsState", async (raw: unknown, options?: unknown) => {
    const read = controlsRead.parse(options);
    const scope = scopeFrom(raw, true);
    const { memory, check } = memoryRead();
    if (!memory) throw Error(memoryMessages.unsupported);
    if (read && "fresh" in read) {
      const state = await memory.readControlsState(scope);
      check();
      scopeFrom(raw, true);
      return state;
    }
    if (read) {
      const status = memory.status();
      if (!status.available) throw Error(status.reason === "offline" ? memoryMessages.offline : memoryMessages.disabled);
      return {doc:memory.docView(scope),version:memory.controlsVersion(scope)??null};
    }
    await memory.ready();
    check();
    scopeFrom(raw, true);
    await memory.refresh();
    check();
    scopeFrom(raw, true);
    return {
      doc: memory.docView(scope),
      version: memory.controlsVersion(scope) ?? null,
    };
  });
  handle(
    "replaceMemoryControls",
    async (raw: unknown, values: unknown, base: unknown, options?: unknown) => {
      const scope = scopeFrom(raw, true);
      const controls = z
        .array(z.string().max(4 * memoryLimits.editChars))
        .max(memoryLimits.editsPerScope)
        .parse(values);
      const version = z.string().min(1).max(200).parse(base);
      const mode = z.object({nonGenerating:z.literal(true)}).strict().optional().parse(options);
      if (mode) {
        // No ready/refresh here: this opt-in path never discovers/enables generation.
        const memory = service();
        if (!memory) throw Error(memoryMessages.unsupported);
        return memory.replaceControls(scope, controls, version, mode);
      }
      return (await required()).replaceControls(scope, controls, version);
    },
  );
  handle("synthesizeMemory", async (raw: unknown, cancellation?: unknown) => {
    const signal = cancellation instanceof AbortSignal ? cancellation : undefined;
    const scope = scopeFrom(raw, true);
    const { memory, check } = memoryRead();
    const task = synthesizer;
    if (!memory || !task) throw new Error(memoryMessages.unsupported);
    const checkCurrent = () => {
      check();
      scopeFrom(raw, true);
    };
    const result = await task.regenerate(scope, signal, checkCurrent);
    checkCurrent();
    if (result.status !== "done")
      throw new Error(result.message ?? "Memory regeneration did not finish.");
    const doc = memory.docView(scope);
    if (!doc) throw new Error("Memory changed. Reload it before continuing.");
    return doc;
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
  handle("resetMemory", async (raw?: unknown, options?: unknown) => {
    const classicOnly = z.strictObject({ classicOnly: z.literal(true) }).optional().parse(options)?.classicOnly === true;
    const store = ctx.store, owner = ctx.activeAccount?.id, generation = ctx.accountActivationIdentity;
    const memory = service();
    const check = () => {
      if (ctx.store !== store || ctx.activeAccount?.id !== owner || ctx.accountActivationIdentity !== generation ||
          ctx.accountRetiring === true || service() !== memory)
        throw Error("Memory account changed.");
    };
    check();
    const scope = raw === undefined ? undefined : scopeFrom(raw, classicOnly);
    const ready = await required();
    check();
    if (ready !== memory) throw Error("Memory account changed.");
    if (classicOnly && raw !== undefined) scopeFrom(raw, true);
    const result = await ready.reset(scope, classicOnly ? { retryOffline: true } : undefined);
    check();
    if (classicOnly) {
      const cleared = scope ?? "global";
      return { doc: ready.docView(cleared), version: ready.controlsVersion(cleared) ?? null };
    }
    if (scope === undefined) resetFiles(false, store);
    return result;
  });
}
