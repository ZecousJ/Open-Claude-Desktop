/**
 * The API page: three service groups (codex and codex-pro of OpenAI, grok of
 * xAI) and a few keys of the account. `apiKeys=none` has no keys, `apiKeys=error` a service that
 * fails, `apiGroups=one` an account with a single group and `apiGroups=none`
 * a local account without any.
 */
import {
  apiProviderDefs,
  apiProviderOf,
  type ApiGroups,
  type ApiKey,
} from "../../../shared/api-keys-api";
import type { FixtureDomain } from "./index";

const hour = 3_600_000;
const day = 24 * hour;

export const apiKeysFixture: FixtureDomain = {
  params: {
    apiKeys: "some (default) | none | error: the account's API keys",
    apiGroups:
      "two (default) | one | none: the service groups of the account",
  },
  bridge: ({ params, origin }) => {
    const mode = params.get("apiKeys") ?? "some";
    const shape = params.get("apiGroups") ?? "two";
    const chosen: Record<string, number> = {};
    // The drawing group (Image generation) and the model in use.
    let imageModel = "gpt-image-2.5";
    const imageModels = [
      { id: "gpt-image-2.5", name: "GPT Image 2.5" },
      { id: "gpt-image-2", name: "GPT Image 2" },
    ];
    const all = [
      {
        id: 2,
        name: "codex",
        models: 6,
        primary: true,
        protocol: "responses",
        platform: "openai",
      },
      {
        id: 4,
        name: "codex-pro",
        models: 8,
        primary: false,
        protocol: "responses",
        platform: "openai",
      },
      {
        id: 3,
        name: "grok",
        models: 3,
        primary: false,
        protocol: "chat",
        platform: "grok",
      },
    ] as const;
    const groups = (): ApiGroups => {
      const list = (
        shape === "none" ? [] : shape === "one" ? all.slice(0, 1) : all
      ).map((group) => ({ ...group }));
      return {
        groups: list,
        providers: apiProviderDefs.map(({ id, name }) => {
          const own = list.filter((group) => apiProviderOf(group.platform).id === id);
          return {
            id,
            name,
            groups: own,
            selected:
              own.find((group) => group.id === chosen[id])?.id ??
              own.find((group) => group.primary)?.id ??
              own[0]?.id ??
              null,
          };
        }),
        ...(shape === "none"
          ? {}
          : {
              images: {
                groupId: 5,
                models: imageModels,
                selected: imageModel,
              },
            }),
      };
    };
    let keys: ApiKey[] =
      mode === "some" || mode === "error"
        ? [
            {
              id: 11,
              name: "Deploy script",
              key: "sk-3f9a1c7e5b2d4a80c6e19f7d2b8a4c05",
              groupId: 2,
              groupName: "codex",
              status: "active",
              createdAt: origin - 3 * day,
              lastUsedAt: origin - 2 * hour,
              totalCost: 16.107432,
            },
            {
              id: 12,
              name: "Notebook",
              key: "sk-91d0e7a4c8b35f6a2e40d1b9c7f38a5e",
              groupId: 3,
              groupName: "grok",
              status: "active",
              createdAt: origin - 9 * day,
              lastUsedAt: null,
              totalCost: 0,
            },
            {
              id: 13,
              name: "Old experiment",
              key: "sk-5c2b8e0f1a7d4936b8c05e2f9a1d7346",
              groupId: 2,
              groupName: "codex",
              status: "expired",
              createdAt: origin - 40 * day,
              lastUsedAt: origin - 30 * day,
              totalCost: 0.4821,
            },
          ]
        : [];
    return {
      apiGroups: async () => groups(),
      // Each group's rate multiplier (the service's defaults and the account's own).
      groupRates: async () => ({ 2: 0.25, 3: 0.2, 4: 1, 5: 1 }),
      setApiGroup: async (providerId: string, id: number) => {
        chosen[providerId] = id;
        return groups();
      },
      setImageModel: async (model: string) => {
        imageModel = model;
        return groups();
      },
      apiKeys: async () => {
        if (mode === "error")
          throw new Error("The service could not list your keys. Try again.");
        return keys.map((key) => ({ ...key }));
      },
      createApiKey: async (input) => {
        const group = all.find((item) => item.id === input.groupId);
        const made: ApiKey = {
          id: 100 + keys.length,
          name: input.name,
          key: `sk-${Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32)}`,
          groupId: input.groupId,
          groupName: group?.name ?? "",
          status: "active",
          createdAt: origin,
          lastUsedAt: null,
        };
        keys = [made, ...keys];
        return made;
      },
      deleteApiKey: async (id: number) => {
        keys = keys.filter((key) => key.id !== id);
      },
    };
  },
};
