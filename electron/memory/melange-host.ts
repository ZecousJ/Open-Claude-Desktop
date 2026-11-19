import { z } from "zod";
import type { AppContext } from "../app/app-context";
import { requestJson, Sub2ApiError } from "../sub2api/http";
import { gatewayCompleter } from "./completion";
import { Melange, MelangeConflictError, melangeStateSchema } from "./melange";
import { projectScope, type MemoryScope } from "./types";

const snapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  state: melangeStateSchema.nullable(),
});

type AccountMelange = {
  current(): boolean;
  dispose(): void;
  service: Melange;
  capability?: Promise<Melange | undefined>;
  available?: boolean;
};

const accounts = new WeakMap<AppContext, AccountMelange>();
const reservations = new WeakMap<AppContext, () => Promise<() => void>>();

export function ownsMemoryProject(ctx: AppContext, id: string) {
  const scope = projectScope(id);
  if (!scope) return false;
  const local = ctx.store.projects.find(project => projectScope(project.id) === scope);
  if (local) return !ctx.store.isProjectDeleting(local.id);
  for (const cloudId of ctx.cloudProjectIds?.() ?? [])
    if (projectScope(cloudId) === scope) return true;
  return false;
}

export function configureMelangeEngineReservation(ctx: AppContext, reserve: () => Promise<() => void>) {
  reservations.set(ctx, reserve);
}

export function existingMelangeForAccount(ctx: AppContext) {
  const account = accounts.get(ctx);
  return account?.current() && account.available ? account.service : undefined;
}

function createMelangeForAccount(ctx: AppContext): Melange | undefined {
  const cached = accounts.get(ctx);
  if (cached?.current()) return cached.service;
  cached?.dispose();
  const remote = ctx.remote;
  const memory = ctx.services.memory?.service;
  const owner = ctx.activeAccount?.id;
  const store = ctx.store;
  const engine = ctx.engine;
  const activation = ctx.accountActivationIdentity;
  if (!remote?.claudex || !memory || !owner || ctx.accountRetiring) return undefined;
  const session = remote.session;
  const current = () => !ctx.accountRetiring &&
    ctx.activeAccount?.id === owner && ctx.store === store &&
    ctx.accountActivationIdentity === activation && ctx.remote === remote &&
    remote.session === session && ctx.services.memory?.service === memory;
  let mode: "melange" | "classic" | "off" | undefined;
  const call = (method: "GET" | "PUT", body?: unknown, checkBeforeWrite?: () => void) => session.authorized(
    async token => {
      checkBeforeWrite?.();
      try {
        return snapshotSchema.parse(await requestJson(
          fetch, new URL("/api/v1/claudex/memory/melange", remote.accounts.baseUrl).href,
          { method, body, token, deviceId: remote.backend.deviceId },
        ));
      } catch (error) {
        if (error instanceof Sub2ApiError && error.status === 409)
          throw new MelangeConflictError();
        throw error;
      }
    },
    current,
  );
  const service = new Melange({
    store: {
      load: async () => {
        const snapshot = await call("GET");
        mode = snapshot.state?.mode;
        return snapshot;
      },
      save: async (baseRevision, state, checkBeforeWrite) => {
        const previous = mode;
        const saved = await call("PUT", { base_revision: baseRevision, state }, checkBeforeWrite);
        mode = saved.state?.mode;
        if (previous !== mode) {
          await memory.refreshAfterWrite();
          if (current() && mode === "melange") ctx.services.memory?.onMelangeEnabled?.();
        }
        return saved;
      },
    },
    isCurrent: current,
    ownsProject: id => current() && ownsMemoryProject(ctx, id),
    canGenerate: () => {
      const status = memory.status();
      return current() && !ctx.policy().pending && status.available && status.allowed.generate;
    },
    complete: async (prompt, options) => {
      const release = await reservations.get(ctx)?.();
      try {
        return await gatewayCompleter(async () => {
          const signal = options?.signal;
          signal?.throwIfAborted();
          if (!current() || engine.policy().update?.state === "required") return undefined;
          const { providers, activeProviderId } = store.settings;
          const provider = providers.find(candidate => candidate.id === activeProviderId);
          if (!provider?.model) return undefined;
          const model = options?.model ?? memory.synthesisModel() ?? provider.model;
          if (model !== provider.model && !provider.models.includes(model)) return undefined;
          if (!engine.gatewayEndpoint() || engine.providerId !== provider.id)
            await engine.ensure(provider, {
              interactive: false,
              current: () => current() && !signal?.aborted,
            });
          signal?.throwIfAborted();
          if (!current() || engine.providerId !== provider.id) return undefined;
          const endpoint = engine.gatewayEndpoint();
          return endpoint ? { ...endpoint, model } : undefined;
        })(prompt, options);
      } finally {
        release?.();
      }
    },
  });
  const detach = ctx.onAccountDeactivating(() => {
    service.dispose();
    accounts.delete(ctx);
    detach?.();
  });
  accounts.set(ctx, { current, service, dispose: () => {
    detach?.();
    service.dispose();
  } });
  return service;
}

export function readyMelangeForAccount(ctx: AppContext) {
  const service = createMelangeForAccount(ctx);
  const account = accounts.get(ctx);
  if (!service || !account?.current()) return Promise.resolve(undefined);
  const status = ctx.services.memory?.service.status();
  if (!status?.available || !status.allowed.generate) return Promise.resolve(undefined);
  account.capability ??= service.read("off")
    .then(() => {
      account.available = account.current();
      return account.available ? service : undefined;
    })
    .catch((error: unknown) => {
      if (!(error instanceof Sub2ApiError) || ![404, 501].includes(error.status))
        account.capability = undefined;
      return undefined;
    });
  return account.capability;
}

export async function classicSourcesForMelange(ctx: AppContext) {
  const memory = ctx.services.memory?.service;
  if (!memory) return [];
  const store = ctx.store;
  const activation = ctx.accountActivationIdentity;
  await memory.ready();
  await memory.refresh();
  if (ctx.accountRetiring || ctx.store !== store || ctx.accountActivationIdentity !== activation ||
      ctx.services.memory?.service !== memory) throw Error("Memory account changed.");
  if (!memory.status().available) throw Error("Memory is temporarily unavailable.");
  const scopes = new Set<MemoryScope>(["global"]);
  for (const id of [...store.projects.map(project => project.id), ...(ctx.cloudProjectIds?.() ?? [])]) {
    const scope = projectScope(id);
    if (scope && ownsMemoryProject(ctx, id)) scopes.add(scope);
  }
  return [...scopes].flatMap(scope => {
    const { doc, edits } = memory.memoryFor(scope);
    const content = [doc?.content, ...edits.map(edit => edit.text)].filter(Boolean).join("\n");
    return content.trim() ? [{ scope, content }] : [];
  });
}
