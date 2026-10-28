import { Gateway } from "../electron/engine/gateway";
import { endpoint } from "../electron/engine/gateway-chat";
import { UsageLedger, localDate } from "../electron/conversations/usage-ledger";
import { ProviderVault } from "./provider-vault";
import {
  hasEnforcedLimits,
  parseRequestLimits,
  type RequestLimits,
} from "./operator-limits";
import { weeklyWindow } from "../electron/conversations/weekly-usage";
import { RequestLimiter } from "./request-limiter";
import {
  BufferedDictation,
  RealtimeDictation,
  TranscriptionFailure,
  type DictationSession,
} from "./transcription";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Provider } from "../shared/types";
import { claudexHeaders } from "../shared/claudex-contract";
import { claudexClientInfo } from "../electron/sub2api/http";
import { parseRequestOptions } from "../shared/gateway-signals";
import { keepConnectionsOpen } from "../electron/app/keep-alive";
import {
  dictationStartOptions,
  maxDictationSeconds,
} from "../shared/voice-api";

/** This build's X-Claudex-* headers for the Claudex service; none for other providers, never the device id. */
const serviceHeaders = (provider: Provider) =>
  provider.backend === "sub2api" ? claudexHeaders(claudexClientInfo()) : {};

type Command = {
  id: number;
  type:
    | "start"
    | "abort"
    | "summary"
    | "test"
    | "stop"
    | "keys"
    | "keyStatus"
    | "dictationStart"
    | "dictationAudio"
    | "dictationFinish"
    | "dictationCancel"
    | "remoteModels"
    | "remoteKeyUsage"
    | "sessionKey"
    | "requestOptions"
    | "threadProduct";
  /** threadProduct: the surface the thread belongs to (usage by product). */
  product?: string;
  profileRoot?: string;
  vaultRoot?: string;
  vaultKey?: string;
  provider?: Provider;
  apiKey?: string;
  limits?: RequestLimits;
  threadId?: string;
  keys?: Record<string, string>;
  /** In-memory keys of the account's other service groups, by vault entry (MG). */
  groupKeys?: Record<string, string>;
  allowedIds?: string[];
  audioBase64?: string;
  maxSeconds?: number;
  options?: unknown;
};
/** Upper bound for an upstream API key; longer values are rejected as malformed. */
const maxApiKeyLength = 16_000;

let gateway: Gateway | undefined;
let ledger: UsageLedger | undefined;
let currentKey = "";
/** The account's other service groups' keys when they are not in the vault (MG). */
let currentGroupKeys: Record<string, string> = {};
let currentProvider: Provider | undefined;
let limiter: RequestLimiter | undefined;
let vault: ProviderVault | undefined;
let dictation:
  | {
      session: DictationSession;
      provider: Provider;
      ledger?: UsageLedger;
      startedAt: number;
    }
  | undefined;

function validApiKey(value: unknown): value is string {
  return typeof value === "string" && value.length <= maxApiKeyLength;
}
/** Group keys by vault entry: at most 30, each a valid key; anything else is refused. */
function groupKeysOf(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid provider key update.");
  const entries = Object.entries(value as Record<string, unknown>);
  if (
    entries.length > 30 ||
    entries.some(
      ([id, key]) =>
        !id || id.length > 100 || !validApiKey(key) || !(key as string),
    )
  )
    throw Error("Invalid provider key update.");
  return Object.fromEntries(entries) as Record<string, string>;
}
/** Opens the encrypted key vault once, importing a one-time bootstrap key if present. */
function getVault(command: Command) {
  if (vault) return vault;
  if (!(command.vaultRoot ?? command.profileRoot) || !command.vaultKey)
    throw Error("Provider vault is not configured.");
  const root = (command.vaultRoot ?? command.profileRoot)!;
  const loaded = new ProviderVault(root, command.vaultKey);
  const bootstrap = path.join(root, "backend", "bootstrap-secret.json");
  if (fs.existsSync(bootstrap)) {
    const parsed: unknown = JSON.parse(fs.readFileSync(bootstrap, "utf8"));
    if (!parsed || typeof parsed !== "object")
      throw Error("Backend bootstrap secret is invalid.");
    const { providerId, apiKey } = parsed as {
      providerId?: unknown;
      apiKey?: unknown;
    };
    const allowed =
      command.allowedIds ?? (command.provider ? [command.provider.id] : []);
    if (
      typeof providerId !== "string" ||
      !allowed.includes(providerId) ||
      typeof apiKey !== "string" ||
      !apiKey ||
      apiKey.length > maxApiKeyLength
    )
      throw Error("Backend bootstrap secret is invalid.");
    loaded.setMany({ [providerId]: apiKey }, allowed);
    fs.rmSync(bootstrap);
  }
  vault = loaded;
  return vault;
}
function reply(id: number, result?: unknown, error?: unknown) {
  let message =
    error instanceof Error
      ? error.message
      : String(error ?? "Unknown service error");
  for (const key of [currentKey, ...Object.values(currentGroupKeys)])
    if (key) message = message.split(key).join("[redacted]");
  process.send?.({
    id,
    ok: error === undefined,
    result,
    error: error === undefined ? undefined : message,
  });
}
/** The operator's request limits, seeded with tokens already used today and this usage week. */
function createLimiter(
  usage: UsageLedger,
  configured: RequestLimits | undefined,
) {
  const limits = parseRequestLimits(configured ?? {});
  if (!hasEnforcedLimits(limits)) return undefined;
  const now = Date.now();
  const day = localDate(now);
  const today = usage.summary("all", now).daily.find((row) => row.date === day);
  return new RequestLimiter(limits, {
    day,
    tokens: (today?.inputTokens ?? 0) + (today?.outputTokens ?? 0),
    weekTokens:
      limits.weeklyTokenLimit === null
        ? 0
        : usage.tokens(
            weeklyWindow(now, limits.weeklyResetDay, limits.weeklyResetHour)
              .start,
            now,
          ),
  });
}
async function startGateway(command: Command) {
  if (gateway) throw Error("Provider service is already running.");
  const { profileRoot, provider, apiKey } = command;
  if (!profileRoot || !provider || !validApiKey(apiKey))
    throw Error("Invalid provider service configuration.");
  endpoint(provider.baseUrl, "responses");
  currentKey = apiKey;
  currentGroupKeys = groupKeysOf(command.groupKeys);
  currentProvider = provider;
  if (command.vaultKey) getVault(command);
  const usage = new UsageLedger(profileRoot);
  ledger = usage;
  limiter = createLimiter(usage, command.limits);
  gateway = new Gateway(
    () => ({
      provider,
      apiKey: currentKey || vault?.get(provider.id) || "",
      // A model of another service group goes out with that group's key (MG).
      keyFor: (id: string) => currentGroupKeys[id] || vault?.get(id) || "",
    }),
    (record) => {
      usage.record(record);
      if (record.usageKnown)
        limiter?.recordUsage(
          record.at,
          record.inputTokens,
          record.outputTokens,
        );
    },
    limiter,
    (event) => process.send?.({ type: "agentPrompt", ...event }),
    (refusal) => process.send?.({ type: "remoteRefusal", ...refusal }),
    {
      onToolDescription: (event) =>
        process.send?.({ type: "toolDescription", ...event }),
      onWebSources: (event) => process.send?.({ type: "webSources", event }),
      // A picture the upstream image tool made reaches the main process,
      // which saves it and shows it as the turn's Image card.
      onGeneratedImage: (event) =>
        process.send?.({ type: "generatedImage", event }),
      // A file write the model has begun shows at once (shared/tool-start.ts).
      onToolStart: (event) => process.send?.({ type: "toolStart", event }),
    },
  );
  const options = command.options && parseRequestOptions(command.options);
  if (options) gateway.setRequestOptions(options);
  await gateway.start();
  return { url: gateway.url, token: gateway.token };
}
/** Largest audio chunk the window sends at once (about two seconds). */
const maxChunkBytes = 64 * 1024;
/** Decodes one strict, canonical base64 chunk of pcm_s16le audio. */
function decodeChunk(encoded: unknown) {
  const maxEncodedLength = Math.ceil((maxChunkBytes * 4) / 3) + 8;
  if (
    typeof encoded !== "string" ||
    encoded.length > maxEncodedLength ||
    !/^[-A-Za-z0-9+/]*=*$/.test(encoded) ||
    encoded.length % 4 !== 0
  )
    throw Error("Invalid audio.");
  const audio = Buffer.from(encoded, "base64");
  if (audio.length > maxChunkBytes || audio.toString("base64") !== encoded)
    throw Error("Invalid audio.");
  return new Uint8Array(audio);
}
/** Opens a dictation session with the stored or supplied key (package C6). */
async function dictationStart(command: Command) {
  const { language } = dictationStartOptions(command.options);
  const { provider } = command;
  if (!provider) throw Error("Invalid dictation request.");
  const maxSeconds = Number(command.maxSeconds);
  if (
    !Number.isSafeInteger(maxSeconds) ||
    maxSeconds < 1 ||
    maxSeconds > maxDictationSeconds
  )
    throw Error("Invalid dictation request.");
  dictation?.session.cancel();
  dictation = undefined;
  endpoint(provider.baseUrl, "responses");
  const key = storedKey(command, provider);
  const session =
    provider.backend === "sub2api"
      ? await RealtimeDictation.open({
          provider,
          apiKey: key,
          headers: serviceHeaders(provider),
          maxSeconds,
          language,
          onRefusal: (refusal) =>
            process.send?.({ type: "remoteRefusal", ...refusal }),
        })
      : new BufferedDictation(provider, key, maxSeconds, language);
  dictation = {
    session,
    provider,
    ledger: command.profileRoot
      ? new UsageLedger(command.profileRoot)
      : undefined,
    startedAt: Date.now(),
  };
  return { streaming: session.streaming, maxSeconds: session.maxSeconds };
}
function dictationAudio(command: Command) {
  if (!dictation) throw Error("Dictation is not running.");
  return dictation.session.append(decodeChunk(command.audioBase64));
}
async function dictationFinish() {
  const current = dictation;
  if (!current) throw Error("Dictation is not running.");
  let statusCode = 502;
  try {
    const text = await current.session.finish();
    statusCode = 200;
    return { text };
  } catch (error) {
    statusCode = error instanceof TranscriptionFailure ? error.statusCode : 502;
    throw error;
  } finally {
    if (dictation === current) dictation = undefined;
    // Dictation has no token usage; the record keeps the request and its outcome only.
    try {
      current.ledger?.record({
        id: randomUUID(),
        at: current.startedAt,
        providerId: current.provider.id,
        model: current.provider.transcriptionModel ?? "",
        protocol: current.provider.protocol,
        durationMs: Date.now() - current.startedAt,
        statusCode,
        usageKnown: false,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
      });
    } catch (error) {
      console.error(
        "Usage record could not be saved:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
function dictationCancel() {
  dictation?.session.cancel();
  dictation = undefined;
  return true;
}
/** Lists the provider's models, using the vault key when none is supplied. */
async function testProvider(command: Command) {
  const { provider, apiKey } = command;
  if (!provider || !validApiKey(apiKey)) throw Error("Invalid provider test.");
  const testKey =
    apiKey ||
    vault?.get(provider.id) ||
    (command.vaultKey ? getVault(command).get(provider.id) : "");
  const response = await fetch(endpoint(provider.baseUrl, "models"), {
    headers: {
      ...serviceHeaders(provider),
      ...(testKey ? { Authorization: `Bearer ${testKey}` } : {}),
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const body = (await response.text())
      .slice(0, 1000)
      .split(testKey)
      .join("[redacted]");
    throw Error(`Model list HTTP ${response.status}: ${body}`);
  }
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !Array.isArray((body as { data?: unknown }).data)
  )
    throw Error("The model list is not OpenAI compatible.");
  const models = (body as { data: Array<{ id?: unknown }> }).data
    .map((item) => item.id)
    .filter((value): value is string => typeof value === "string");
  return { models, message: `Found ${models.length} models.` };
}
/** The vault key for a provider, opening the vault when this child has not yet. */
function storedKey(command: Command, provider: Provider) {
  return (
    (validApiKey(command.apiKey) && command.apiKey) ||
    vault?.get(provider.id) ||
    (command.vaultKey ? getVault(command).get(provider.id) : "")
  );
}
/** A gateway GET with the stored key; failures come back as data so the caller can map Sub2API's codes. */
async function remoteGet(command: Command, route: string) {
  const { provider } = command;
  if (!provider || provider.backend !== "sub2api")
    throw Error("Invalid service request.");
  const key = storedKey(command, provider);
  if (!key) return { ok: false, status: 401, body: "" };
  const response = await fetch(endpoint(provider.baseUrl, route), {
    headers: {
      ...serviceHeaders(provider),
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(20000),
    redirect: "error",
  });
  const body = (await response.text())
    .slice(0, 1_000_000)
    .split(key)
    .join("[redacted]");
  return { ok: response.ok, status: response.status, body };
}
/** `GET /v1/models` with the device key: Sub2API filters it by the group's allowlist. */
async function remoteModels(command: Command) {
  const result = await remoteGet(command, "models");
  if (!result.ok) return result;
  try {
    const data = (JSON.parse(result.body) as { data?: unknown }).data;
    if (!Array.isArray(data)) throw Error();
    const models = data
      .map((item) => (item as { id?: unknown })?.id)
      .filter(
        (value): value is string =>
          typeof value === "string" && !!value && value.length <= 200,
      )
      .slice(0, 2000);
    return { ok: true, status: result.status, models: [...new Set(models)] };
  } catch {
    return { ok: false, status: 502, body: "" };
  }
}
async function stopGateway() {
  dictationCancel();
  await gateway?.close();
  gateway = undefined;
  currentKey = "";
  currentGroupKeys = {};
  currentProvider = undefined;
  limiter = undefined;
  process.exitCode = 0;
  return true;
}
const handlers: Record<Command["type"], (command: Command) => unknown> = {
  start: startGateway,
  dictationStart,
  dictationAudio,
  dictationFinish,
  dictationCancel,
  test: testProvider,
  stop: stopGateway,
  abort(command) {
    if (command.threadId) gateway?.abortThread(command.threadId);
    return true;
  },
  summary: () => ledger?.summary(),
  remoteModels,
  // The key-level fallback for the weekly banner (`GET /v1/usage`).
  remoteKeyUsage: (command) => remoteGet(command, "usage"),
  // A key held only for this run (no OS encryption to store it), replaced after re-provisioning.
  sessionKey(command) {
    if (!validApiKey(command.apiKey) || !command.apiKey || !currentProvider)
      throw Error("Invalid provider key update.");
    const groupKeys = groupKeysOf(command.groupKeys);
    currentKey = command.apiKey;
    currentGroupKeys = { ...currentGroupKeys, ...groupKeys };
    return true;
  },
  // Which product a thread's requests count under (usage by product).
  threadProduct(command) {
    if (
      !gateway ||
      typeof command.threadId !== "string" ||
      !["code", "cowork", "chat"].includes(command.product ?? "")
    )
      throw Error("Invalid thread product.");
    gateway.setThreadProduct(
      command.threadId,
      command.product as "code" | "cowork" | "chat",
    );
    return true;
  },
  // How the gateway rewrites requests (S1: shell descriptions, X search).
  requestOptions(command) {
    const options = parseRequestOptions(command.options);
    if (!options || !gateway) throw Error("Invalid request options.");
    gateway.setRequestOptions(options);
    return true;
  },
  keyStatus: (command) => getVault(command).status(command.allowedIds ?? []),
  keys(command) {
    if (!command.keys || !command.allowedIds)
      throw Error("Invalid provider key update.");
    return getVault(command).setMany(command.keys, command.allowedIds);
  },
};
async function handle(command: Command) {
  try {
    if (!Object.hasOwn(handlers, command.type))
      throw Error("Unknown provider service command.");
    reply(command.id, await handlers[command.type](command));
  } catch (error) {
    reply(command.id, undefined, error);
  }
}
keepConnectionsOpen();

process.on("message", (message: unknown) => {
  if (
    message &&
    typeof message === "object" &&
    typeof (message as Command).id === "number"
  )
    void handle(message as Command);
});
process.on("disconnect", () => {
  dictationCancel();
  void Promise.resolve(gateway?.close()).finally(() => {
    currentKey = "";
    process.exit(0);
  });
});
