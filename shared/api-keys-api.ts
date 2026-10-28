/**
 * The API page (sidebar → API): which service group each provider's models
 * come from, and the account's own API keys.
 *
 * A Claudex service sorts its models into groups, each of one provider's
 * platform (for example `codex` for OpenAI and `grok` for xAI); a provider
 * may have several. Claudex holds a key for every group the account may use
 * and merges their models; choosing a provider's group here narrows that
 * provider's models in the model menus of Chat, Cowork and Code, in the app
 * and on the web, to that group's models. The keys are the ordinary Sub2API API keys of the
 * account: created, listed and deleted through the service's own key
 * endpoints. The keys Claudex creates for its own devices are not listed.
 */
import { bridgeMethods } from "./bridge-methods";

/** A service group the account may use, as this app knows it. */
export interface ApiGroup {
  id: number;
  name: string;
  /** How many models the group serves. */
  models: number;
  /** Those models (catalog order): id and the name the menus show. */
  modelList?: { id: string; name: string }[];
  /** The account's plan group, which Claudex uses until another is chosen. */
  primary: boolean;
  /** The group's provider speaks OpenAI Responses or Chat Completions. */
  protocol: "responses" | "chat";
  /** The service's platform of the group: openai, grok, anthropic, … */
  platform: string;
}

/** One provider with the groups of its platforms the account may use. */
export interface ApiProvider {
  id: string;
  name: string;
  groups: ApiGroup[];
  /** The group whose models the menus list for this provider; null without a group. */
  selected: number | null;
}

/**
 * Image generation: the drawing group's image models, one of which makes every
 * picture, whatever the conversation's model.
 */
export interface ApiImages {
  groupId: number;
  models: { id: string; name: string }[];
  /** The model pictures are made with. */
  selected: string;
}

export interface ApiGroups {
  /** Every group of the account (a new key picks among them). */
  groups: ApiGroup[];
  /** The drawing group's models and the one in use; absent without one. */
  images?: ApiImages;
  /** The providers, the well-known ones first even when they have no group. */
  providers: ApiProvider[];
  /** The service's origin, where requests with the keys go (the API page shows it). */
  origin?: string;
}

/** The providers the page always lists, and the service platforms each covers. */
export const apiProviderDefs: readonly {
  id: string;
  name: string;
  platforms: readonly string[];
}[] = [
  { id: "openai", name: "OpenAI", platforms: ["openai"] },
  { id: "xai", name: "xAI", platforms: ["grok", "xai"] },
  { id: "anthropic", name: "Messages API", platforms: ["anthropic"] },
  { id: "gemini", name: "Google Gemini", platforms: ["gemini", "antigravity"] },
  { id: "qwen", name: "Qwen", platforms: ["qwen", "dashscope", "tongyi"] },
  { id: "deepseek", name: "DeepSeek", platforms: ["deepseek"] },
];

/** The provider a service platform belongs to; an unknown platform is its own. */
export function apiProviderOf(platform: string): { id: string; name: string } {
  const key = platform.trim().toLowerCase();
  const known = apiProviderDefs.find((def) => def.platforms.includes(key));
  if (known) return { id: known.id, name: known.name };
  const id = key || "other";
  return { id, name: id.charAt(0).toUpperCase() + id.slice(1) };
}

export type ApiKeyStatus = "active" | "inactive" | "expired" | "exhausted";

/** One of the account's own API keys. */
export interface ApiKey {
  id: number;
  name: string;
  /** The whole key: the page masks it and copies it on request. */
  key: string;
  groupId: number | null;
  groupName: string;
  status: ApiKeyStatus;
  /** Milliseconds since the epoch. */
  createdAt: number | null;
  lastUsedAt: number | null;
  /**
   * What the service has charged for the key in all, in dollars (its
   * `total_actual_cost`); absent when the usage could not be read.
   */
  totalCost?: number;
}

export interface ApiKeyInput {
  name: string;
  groupId: number;
}

export interface ApiKeysAPI {
  /**
   * The groups and the one in use, as last read; `fresh` reads the
   * account's groups and models from the service first (at most every 30 s).
   */
  apiGroups(fresh?: boolean): Promise<ApiGroups>;
  /** Uses a group's models for its provider; the model menus follow at once. */
  setApiGroup(providerId: string, groupId: number): Promise<ApiGroups>;
  /** Makes every picture with this image model of the drawing group. */
  setImageModel(model: string): Promise<ApiGroups>;
  /** The account's own keys, newest first. */
  apiKeys(): Promise<ApiKey[]>;
  createApiKey(input: ApiKeyInput): Promise<ApiKey>;
  deleteApiKey(id: number): Promise<void>;
  /**
   * Each group's rate multiplier for this account: its own rate where the
   * administrator set one, else the group's.
   */
  groupRates(): Promise<Record<number, number>>;
}

export const apiKeysMethods = bridgeMethods<ApiKeysAPI>({
  apiGroups: true,
  setApiGroup: true,
  setImageModel: true,
  apiKeys: true,
  createApiKey: true,
  deleteApiKey: true,
  groupRates: true,
});

/**
 * The rates from the service's `/groups/available` (each group's
 * `rate_multiplier`) and `/groups/rates` (the account's own, by group id).
 */
export function groupRatesFrom(
  available: unknown,
  own: unknown,
): Record<number, number> {
  const out: Record<number, number> = {};
  const rate = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
  if (Array.isArray(available))
    for (const group of available) {
      const r = rate(group?.rate_multiplier);
      if (Number.isSafeInteger(group?.id) && r !== undefined) out[group.id] = r;
    }
  if (own && typeof own === "object" && !Array.isArray(own))
    for (const [id, value] of Object.entries(own)) {
      const r = rate(value);
      if (/^\d+$/.test(id) && r !== undefined) out[Number(id)] = r;
    }
  return out;
}

/** Key ids per `POST /usage/dashboard/api-keys-usage` (the service takes at most 100). */
export const keyUsageBatch = 100;

/**
 * The keys with their total charges. `stats` is the merged `data.stats` of
 * `POST /api/v1/usage/dashboard/api-keys-usage`, by key id; a key it does not
 * name has not been charged yet.
 */
export function withKeyCosts(keys: ApiKey[], stats: unknown): ApiKey[] {
  const byId =
    stats && typeof stats === "object"
      ? (stats as Record<string, { total_actual_cost?: unknown } | undefined>)
      : {};
  return keys.map((key) => {
    const cost = byId[String(key.id)]?.total_actual_cost;
    return {
      ...key,
      totalCost: typeof cost === "number" && Number.isFinite(cost) ? cost : 0,
    };
  });
}

/** 0.25 → "0.25x", 1 → "1x", as Sub2API writes a group's rate. */
export const rateText = (rate: number) =>
  `${Number(rate.toFixed(4)).toString()}x`;

export const apiKeyNameLimit = 100;

/**
 * Names the service keeps for the keys Claudex makes for its own devices
 * (the web app, this installation, older installations). Those keys are not
 * the person's to list or delete, and a new key cannot take such a name.
 */
export const reservedKeyPrefixes = [
  "claudex-web:",
  "claudex-device:",
  "claudex-desktop:",
] as const;

export const isDeviceKey = (name: string) =>
  reservedKeyPrefixes.some((prefix) => name.startsWith(prefix));

/** Why a key name cannot be used, or undefined when it can. */
export function apiKeyNameProblem(value: string): string | undefined {
  const name = value.trim();
  if (!name) return "Enter a name for the key.";
  if (name.length > apiKeyNameLimit)
    return `Names can be up to ${apiKeyNameLimit} characters.`;
  if (isDeviceKey(name)) return "That name is reserved for Claudex devices.";
  return undefined;
}

/** "sk-abc…wxyz": enough to tell keys apart, never the whole secret. */
export function maskedKey(key: string) {
  if (key.length <= 12) return "•".repeat(Math.max(key.length, 8));
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}

const statusOf = (value: unknown): ApiKeyStatus =>
  value === "inactive" || value === "expired"
    ? value
    : value === "quota_exhausted"
      ? "exhausted"
      : "active";

const time = (value: unknown) => {
  if (typeof value !== "string" || !value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
};

/**
 * The service's key list (`data.items` of `GET /api/v1/keys`) as the page
 * shows it: without the device keys, newest first. `groups` names the
 * groups by id for keys that do not carry their group.
 */
export function apiKeysFrom(
  items: unknown,
  groups: ReadonlyMap<number, string> = new Map(),
): ApiKey[] {
  if (!Array.isArray(items)) return [];
  const keys: ApiKey[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (
      !Number.isSafeInteger(item.id) ||
      typeof item.key !== "string" ||
      typeof item.name !== "string" ||
      isDeviceKey(item.name)
    )
      continue;
    const groupId = Number.isSafeInteger(item.group_id)
      ? (item.group_id as number)
      : null;
    const own = (item.group as { name?: unknown } | null | undefined)?.name;
    keys.push({
      id: item.id as number,
      name: item.name.slice(0, 200),
      key: item.key,
      groupId,
      groupName:
        typeof own === "string" && own
          ? own
          : (groupId !== null && groups.get(groupId)) || "",
      status: statusOf(item.status),
      createdAt: time(item.created_at),
      lastUsedAt: time(item.last_used_at),
    });
  }
  return keys.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}
