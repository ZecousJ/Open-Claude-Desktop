import { z } from "zod";
import {
  apiKeyNameProblem,
  apiKeysFrom,
  keyUsageBatch,
  withKeyCosts,
  groupRatesFrom,
  apiKeysMethods,
  isDeviceKey,
  type ApiGroups,
  type ApiKey,
} from "../../shared/api-keys-api";
import type { AppContext, IpcHandle } from "../app/app-context";
import { requestJson } from "../sub2api/http";

const noAccount = "API keys belong to a Claudex account. Sign in to use them.";

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
  let checkedAt = 0;
  handle("apiGroups", async (rawFresh: unknown): Promise<ApiGroups> => {
    const remote = ctx.remote;
    if (!remote?.ready) return empty;
    if (rawFresh === true && Date.now() - checkedAt > 30_000) {
      checkedAt = Date.now();
      await remote.refreshModels().catch(() => {});
    }
    return remote.ready ? remote.apiGroups() : empty;
  });
  handle(
    "setApiGroup",
    (rawProvider: unknown, rawGroup: unknown): ApiGroups => {
      const provider = z.string().min(1).max(40).parse(rawProvider);
      const id = z.number().int().positive().parse(rawGroup);
      const remote = ctx.remote;
      if (!remote?.ready) throw Error(noAccount);
      return remote.useGroup(provider, id);
    },
  );

  handle("setImageModel", (rawModel: unknown): ApiGroups => {
    const model = z
      .string()
      .min(1)
      .max(200)
      .regex(/^[\w.:/-]+$/)
      .parse(rawModel);
    const remote = ctx.remote;
    if (!remote?.ready) throw Error(noAccount);
    return remote.useImageModel(model);
  });
  // Every picture is made with the model chosen here (the gateway's request
  // options carry it to the engines, also the spaces' on a runner).
  ctx.onAccountActivated(() => {
    ctx.engine.imageModel = () =>
      ctx.remote?.ready ? ctx.remote.imageModel() : "";
  });

  const service = () => {
    const backend = ctx.remote?.ready ? ctx.remote.backend : undefined;
    if (!backend) throw Error(noAccount);
    return backend;
  };
  /** The account's own keys, with the group names the service lists. */
  const list = async (): Promise<ApiKey[]> => {
    const backend = service();
    return backend.session.authorized(async (token) => {
      const groups = new Map(
        (await backend.client.availableGroups(token).catch(() => [])).map(
          (group) => [group.id, group.name] as const,
        ),
      );
      const raw: unknown[] = [];
      for (let page = 1, pages = 1; page <= pages; page++) {
        const read = await backend.client.listKeys(token, "", page);
        pages = read.pages;
        for (const item of read.items)
          raw.push({
            id: item.id,
            name: item.name,
            key: item.key,
            group_id: item.groupId,
            status: item.status,
            created_at: item.createdAt
              ? new Date(item.createdAt).toISOString()
              : null,
            last_used_at: item.lastUsedAt
              ? new Date(item.lastUsedAt).toISOString()
              : null,
          });
      }
      const keys = apiKeysFrom(raw, groups);
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
          // requestJson already unwraps the service's {code, data} envelope.
          Object.assign(stats, body?.stats);
        }
        return withKeyCosts(keys, stats);
      } catch {
        return keys;
      }
    });
  };
  handle("apiKeys", list);
  handle("groupRates", async (): Promise<Record<number, number>> => {
    const backend = service();
    const get = (path: string) =>
      backend.session
        .authorized((token) =>
          requestJson(fetch, `${backend.accounts.baseUrl}/api/v1${path}`, {
            token,
          }),
        )
        .then((body) =>
          body && typeof body === "object" && "data" in body
            ? (body as { data: unknown }).data
            : body,
        );
    const [available, own] = await Promise.all([
      get("/groups/available"),
      get("/groups/rates").catch(() => undefined),
    ]);
    return groupRatesFrom(available, own);
  });
  handle("createApiKey", async (raw: unknown): Promise<ApiKey> => {
    const input = z
      .object({ name: z.string(), groupId: z.number().int().positive() })
      .parse(raw);
    const problem = apiKeyNameProblem(input.name);
    if (problem) throw Error(problem);
    const backend = service();
    const created = await backend.session.authorized((token) =>
      backend.client.createKey(token, input.name.trim(), input.groupId),
    );
    const made = (await list()).find((key) => key.id === created.id);
    if (!made) throw Error("The key was created but could not be read back.");
    return made;
  });
  handle("deleteApiKey", async (raw: unknown) => {
    const id = z.number().int().positive().parse(raw);
    const backend = service();
    // Only the account's own keys: a device key's deletion would cut the
    // app or the web off the service.
    if (!(await list()).some((key) => key.id === id && !isDeviceKey(key.name)))
      throw Error("That key isn't in your list any more.");
    await backend.session.authorized((token) =>
      backend.client.deleteKey(token, id),
    );
  });
  // Keeps this list and the bridge's in step.
  void apiKeysMethods;
}
