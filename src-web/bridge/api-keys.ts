/**
 * The API page's key calls (shared/api-keys-api.ts) on the web: plain JSON
 * requests to the service's own key endpoints with the session's access
 * token. The group in use is not here: it is a setting on the user's runner
 * (`apiGroups` and `setApiGroup` are relayed calls).
 */
import {
  apiKeyNameProblem,
  apiKeysFrom,
  keyUsageBatch,
  withKeyCosts,
  groupRatesFrom,
  isDeviceKey,
  type ApiKey,
  type ApiKeyInput,
  type ApiKeysAPI,
} from "../../shared/api-keys-api";
import type { WebTransport } from "../../shared/web-client/transport";

type Method = (...args: any[]) => Promise<unknown>;

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/** The value of the service's `{code, data}` answer. */
function data(body: unknown): unknown {
  const wrapped = body as { data?: unknown } | undefined;
  return wrapped && typeof wrapped === "object" && "data" in wrapped
    ? wrapped.data
    : body;
}

export function createApiKeyMethods(
  transport: Pick<WebTransport, "json">,
): Pick<
  { [K in keyof ApiKeysAPI]: Method },
  "apiKeys" | "createApiKey" | "deleteApiKey" | "groupRates"
> {
  const list = async (): Promise<ApiKey[]> => {
    const groups = new Map<number, string>();
    try {
      const available = data(await transport.json("/api/v1/groups/available"));
      if (Array.isArray(available))
        for (const group of available)
          if (
            Number.isSafeInteger(group?.id) &&
            typeof group?.name === "string"
          )
            groups.set(group.id, group.name);
    } catch {
      // Keys carry their own group; the names are a convenience.
    }
    const items: unknown[] = [];
    for (let page = 1, pages = 1; page <= Math.min(pages, 50); page++) {
      const read = data(
        await transport.json(`/api/v1/keys?page=${page}&page_size=100`),
      ) as { items?: unknown; pages?: unknown } | undefined;
      if (Array.isArray(read?.items)) items.push(...read.items);
      pages = typeof read?.pages === "number" ? read.pages : 1;
    }
    const keys = apiKeysFrom(items, groups);
    // The charges are a convenience: the keys show without them.
    try {
      const stats: Record<string, unknown> = {};
      for (let at = 0; at < keys.length; at += keyUsageBatch) {
        const read = data(
          await transport.json(
            "/api/v1/usage/dashboard/api-keys-usage",
            json("POST", {
              api_key_ids: keys
                .slice(at, at + keyUsageBatch)
                .map((key) => key.id),
            }),
          ),
        ) as { stats?: Record<string, unknown> } | undefined;
        Object.assign(stats, read?.stats);
      }
      return withKeyCosts(keys, stats);
    } catch {
      return keys;
    }
  };
  return {
    groupRates: async () => {
      const [available, own] = await Promise.all([
        transport.json("/api/v1/groups/available").then(data),
        transport.json("/api/v1/groups/rates").then(data, () => undefined),
      ]);
      return groupRatesFrom(available, own);
    },
    apiKeys: list,
    createApiKey: async (input: ApiKeyInput) => {
      const problem = apiKeyNameProblem(input.name);
      if (problem) throw new Error(problem);
      const created = data(
        await transport.json(
          "/api/v1/keys",
          json("POST", { name: input.name.trim(), group_id: input.groupId }),
        ),
      ) as { id?: number } | undefined;
      const made = (await list()).find((key) => key.id === created?.id);
      if (!made)
        throw new Error("The key was created but could not be read back.");
      return made;
    },
    deleteApiKey: async (id: number) => {
      // Only the account's own keys: a device key's deletion would cut the
      // web app off the service.
      if (
        !(await list()).some((key) => key.id === id && !isDeviceKey(key.name))
      )
        throw new Error("That key isn't in your list any more.");
      await transport.json(`/api/v1/keys/${id}`, json("DELETE"));
    },
  };
}
