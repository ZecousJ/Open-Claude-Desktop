import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  apiKeyNameProblem,
  apiKeysFrom,
  keyUsageBatch,
  withKeyCosts,
  groupRatesFrom,
  type ApiGroups,
  type ApiKey,
} from "../../shared/api-keys-api";
import { assertAccountOperationCurrent } from "../account/operation-lease";
import type { AppContext, IpcHandle } from "../app/app-context";
import type { RemoteKey } from "../sub2api/client";
import { requestJson } from "../sub2api/http";

const noAccount = "API keys belong to a Claudex account. Sign in to use them.";

function wireKey(item: RemoteKey) {
  return {
    id: item.id,
    name: item.name,
    key: item.key,
    group_id: item.groupId,
    status: item.status,
    created_at:
      item.createdAt == null ? null : new Date(item.createdAt).toISOString(),
    last_used_at:
      item.lastUsedAt == null ? null : new Date(item.lastUsedAt).toISOString(),
  };
}

/**
 * The API page (shared/api-keys-api.ts). The keys are the account's own
 * Sub2API keys, read and written with the session's token in the main
 * process; the window never holds the token. The group in use is a setting
 * the model menus follow (RemoteHost.useGroup), so it also runs on a web
 * user's runner.
 */
export function registerApiKeyHandlers(handle: IpcHandle, ctx: AppContext) {
  const empty: ApiGroups = { groups: [], providers: [] };
  // A group the administrator added after this account's models were read
  // gets its key when the page opens: the page shows the groups as last read
  // at once, then asks again with `fresh`, and the bootstrap lists the
  // missing key and the backend's load registers again (at most every 30 s).
  const checkedAt = new WeakMap<NonNullable<AppContext["remote"]>, number>();
  const operation = (remote: NonNullable<AppContext["remote"]>) => {
    const { store, accountActivationIdentity: activation } = ctx;
    const current = () =>
      ctx.remote === remote &&
      remote.ready &&
      !ctx.accountRetiring &&
      ctx.store === store &&
      ctx.accountActivationIdentity === activation;
    const check = () => assertAccountOperationCurrent(current);
    check();
    return { backend: remote.backend, current, check };
  };
  const service = () => {
    const remote = ctx.remote;
    if (!remote?.ready) throw Error(noAccount);
    return operation(remote);
  };
  handle("apiGroups", async (rawFresh: unknown): Promise<ApiGroups> => {
    const remote = ctx.remote;
    if (!remote?.ready) return empty;
    const { check } = operation(remote);
    const now = Date.now();
    if (rawFresh === true && now - (checkedAt.get(remote) ?? 0) > 30_000) {
      checkedAt.set(remote, now);
      await remote.refreshModels().catch(() => {});
    }
    check();
    return remote.apiGroups();
  });
  handle(
    "setApiGroup",
    async (rawProvider: unknown, rawGroup: unknown): Promise<ApiGroups> => {
      const provider = z.string().min(1).max(40).parse(rawProvider);
      const id = z.number().int().positive().parse(rawGroup);
      const remote = ctx.remote;
      if (!remote?.ready) throw Error(noAccount);
      const { check } = operation(remote);
      const groups = await remote.useGroup(provider, id);
      check();
      return groups;
    },
  );

  /** The account's own keys, with the group names the service lists. */
  const list = async (
    { backend, current, check }: ReturnType<typeof service>,
    details: boolean,
  ): Promise<ApiKey[]> => {
    return backend.session.authorized(async (token) => {
      check();
      const groups = new Map(
        (details
          ? await backend.client.availableGroups(token).catch(() => [])
          : []
        ).map((group) => [group.id, group.name] as const),
      );
      check();
      const raw: RemoteKey[] = [];
      for (let page = 1, pages = 1; page <= pages; page++) {
        const read = await backend.client.listKeys(token, "", page);
        check();
        pages = read.pages;
        raw.push(...read.items);
      }
      const keys = apiKeysFrom(raw.map(wireKey), groups);
      if (!details) return keys;
      // The charges are a convenience: the keys show without them.
      try {
        const stats: Record<string, unknown> = {};
        for (let at = 0; at < keys.length; at += keyUsageBatch) {
          const body = (await requestJson(
            fetch,
            `${backend.accounts.baseUrl}/api/v1/usage/dashboard/api-keys-usage`,
            {
              method: "POST",
              body: {
                api_key_ids: keys
                  .slice(at, at + keyUsageBatch)
                  .map((key) => key.id),
              },
              token,
            },
          )) as { stats?: Record<string, unknown> } | undefined;
          check();
          // requestJson already unwraps the service's {code, data} envelope
          // (owner, 2026-10-10: reading data.stats here left every key at $0.00).
          Object.assign(stats, body?.stats);
        }
        return withKeyCosts(keys, stats);
      } catch {
        check();
        return keys;
      }
    }, current);
  };
  handle("apiKeys", () => list(service(), true));
  handle("groupRates", async (): Promise<Record<number, number>> => {
    const { backend, current, check } = service();
    const get = (path: string) =>
      backend.session
        .authorized((token) => {
          check();
          return requestJson(
            fetch,
            `${backend.accounts.baseUrl}/api/v1${path}`,
            { token },
          );
        }, current)
        .then((body) =>
          body && typeof body === "object" && "data" in body ? body.data : body,
        );
    const [available, own] = await Promise.all([
      get("/groups/available"),
      get("/groups/rates").catch(() => undefined),
    ]);
    check();
    return groupRatesFrom(available, own);
  });
  handle("createApiKey", async (raw: unknown): Promise<ApiKey> => {
    const input = z
      .object({ name: z.string(), groupId: z.number().int().positive() })
      .parse(raw);
    const problem = apiKeyNameProblem(input.name);
    if (problem) throw Error(problem);
    const { backend, current, check } = service();
    const idempotencyKey = randomUUID();
    const created = await backend.session.authorized((token) => {
      check();
      return backend.client.createKey(
        token,
        input.name.trim(),
        input.groupId,
        idempotencyKey,
      );
    }, current);
    check();
    const groups = new Map(
      backend.serviceGroups().map(({ id, name }) => [id, name]),
    );
    const [made] = apiKeysFrom([wireKey(created)], groups);
    if (!made) throw Error("The key was created but could not be read back.");
    return made;
  });
  handle("deleteApiKey", async (raw: unknown) => {
    const id = z.number().int().positive().parse(raw);
    const account = service();
    // Only the account's own keys: a device key's deletion would cut the
    // app or the web off the service.
    const keys = await list(account, false);
    account.check();
    if (!keys.some((key) => key.id === id))
      throw Error("That key isn't in your list any more.");
    await account.backend.session.authorized((token) => {
      account.check();
      return account.backend.client.deleteKey(token, id);
    }, account.current);
    account.check();
  });
}
