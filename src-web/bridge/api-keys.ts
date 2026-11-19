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
  type ApiKey,
  type ApiKeyInput,
  type ApiKeysAPI,
} from "../../shared/api-keys-api";
import type { WebTransport } from "../../shared/web-client/transport";

const json = (
  method: string,
  body?: unknown,
  headers?: Record<string, string>,
): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json", ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/** The value of the service's `{code, data}` answer. */
function data(body: unknown): unknown {
  return body && typeof body === "object" && "data" in body ? body.data : body;
}

export function createApiKeyMethods(
  transport: Pick<WebTransport, "json" | "captureActivation">,
): Pick<
  ApiKeysAPI,
  "apiKeys" | "createApiKey" | "deleteApiKey" | "groupRates"
> {
  const operation = () => {
    const check = transport.captureActivation();
    const request: WebTransport["json"] = async (path, init) => {
      check();
      const read = await transport.json(path, init);
      check();
      return read;
    };
    return { check, request };
  };
  const list = async (
    { check, request }: ReturnType<typeof operation>,
    details: boolean,
  ): Promise<ApiKey[]> => {
    const groups = new Map<number, string>();
    if (details) {
      try {
        const available = data(await request("/api/v1/groups/available"));
        if (Array.isArray(available))
          for (const group of available)
            if (
              Number.isSafeInteger(group?.id) &&
              typeof group?.name === "string"
            )
              groups.set(group.id, group.name);
      } catch {
        check();
        // Keys carry their own group; the names are a convenience.
      }
    }
    const items: unknown[] = [];
    for (let page = 1, pages = 1; page <= Math.min(pages, 50); page++) {
      const read = data(
        await request(`/api/v1/keys?page=${page}&page_size=100`),
      ) as { items?: unknown; pages?: unknown } | undefined;
      if (Array.isArray(read?.items)) items.push(...read.items);
      pages = typeof read?.pages === "number" ? read.pages : 1;
    }
    const keys = apiKeysFrom(items, groups);
    if (!details) return keys;
    // The charges are a convenience: the keys show without them.
    try {
      const stats: Record<string, unknown> = {};
      for (let at = 0; at < keys.length; at += keyUsageBatch) {
        const read = data(
          await request(
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
      check();
      return keys;
    }
  };
  return {
    groupRates: async () => {
      const { check, request } = operation();
      const [available, own] = await Promise.all([
        request("/api/v1/groups/available").then(data),
        request("/api/v1/groups/rates").then(data, () => undefined),
      ]);
      check();
      return groupRatesFrom(available, own);
    },
    apiKeys: async () => {
      const scope = operation();
      const keys = await list(scope, true);
      scope.check();
      return keys;
    },
    createApiKey: async (input: ApiKeyInput) => {
      const problem = apiKeyNameProblem(input.name);
      if (problem) throw new Error(problem);
      const { check, request } = operation();
      const created = data(
        await request(
          "/api/v1/keys",
          json(
            "POST",
            { name: input.name.trim(), group_id: input.groupId },
            { "Idempotency-Key": crypto.randomUUID() },
          ),
        ),
      );
      check();
      const [made] = apiKeysFrom([created]);
      if (!made)
        throw new Error("The key was created but could not be read back.");
      return made;
    },
    deleteApiKey: async (id: number) => {
      // Only the account's own keys: a device key's deletion would cut the
      // web app off the service.
      const scope = operation();
      const keys = await list(scope, false);
      scope.check();
      if (!keys.some((key) => key.id === id))
        throw new Error("That key isn't in your list any more.");
      await scope.request(`/api/v1/keys/${id}`, json("DELETE"));
      scope.check();
    },
  };
}
