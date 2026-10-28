import fs from "node:fs";
import path from "node:path";
import {
  attachmentTypes,
  lockedPolicy,
  openPolicy,
  type ClientPolicy,
  type ConnectorRule,
  type PolicyLink,
  type PolicyMode,
} from "../shared/client-policy";
import { clientUpdate } from "../shared/client-policy-rules";

/**
 * The Claudex policy file for LOCAL accounts, `backend/policy.json` in the
 * app's data folder. Local accounts are for development and offline use on
 * the operator's own computer, so the file lives there too. Sub2API accounts
 * never read it: their policy comes from the Claudex service (see
 * ServerPolicySource in electron/client-policy.ts), which resolves it by the
 * user's plan group, not by any name.
 */
type Platform = "darwin" | "win32" | "linux";
const platforms: Platform[] = ["darwin", "win32", "linux"];
const policyModes: PolicyMode[] = ["auto", "manual", "acceptEdits", "plan"];
export interface PolicyPatch {
  scheduledTasks?: Partial<ClientPolicy["scheduledTasks"]>;
  permissionModes?:
    PolicyMode[] | Partial<Record<Platform | "default", PolicyMode[]>>;
  incognito?: boolean;
  webSearch?: boolean;
  voice?: boolean;
  localMcpEditing?: boolean;
  developerModeEnabled?: boolean;
  desktopExtensionsEnabled?: boolean;
  developerMcpEnabled?: boolean;
  remoteImages?: boolean;
  externalLinks?: boolean;
  connectors?: ConnectorRule[] | null;
  attachments?: { maxMegabytes?: number | null; types?: string[] };
  links?: {
    help?: string | null;
    plans?: string | null;
    apps?: string | null;
    learnMore?: PolicyLink[];
  };
}
export interface PolicyAnnouncement {
  id: string;
  title: string;
  content: string;
  popup?: boolean;
  startsAt?: string;
  endsAt?: string;
}
export interface OperatorPolicyFile {
  version: 1;
  defaults?: PolicyPatch;
  /** Overrides per local account id. */
  accounts?: Record<string, PolicyPatch>;
  client?: {
    latestVersion?: string;
    minimumVersion?: string;
    downloadUrl?: string;
  };
  /** Notices for local accounts (Sub2API accounts read the service's announcements). */
  announcements?: PolicyAnnouncement[];
}

type Json = Record<string, unknown>;
function fail(where: string, what: string): never {
  throw Error(`Claudex policy: ${where} ${what}.`);
}
function record(value: unknown, where: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(where, "must be an object");
  return value as Json;
}
function only(value: Json, keys: string[], where: string) {
  for (const key of Object.keys(value))
    if (!keys.includes(key)) fail(`${where}.${key}`, "is not a known field");
}
function boolean(value: unknown, where: string) {
  if (typeof value !== "boolean") fail(where, "must be true or false");
  return value;
}
/** Only plain https pages without embedded credentials. */
export function isPolicyUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2000) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
function url(value: unknown, where: string) {
  if (value === null) return null;
  if (!isPolicyUrl(value)) fail(where, "must be an https URL");
  return value;
}
function label(value: unknown, where: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 60)
    fail(where, "must be a label of 1–60 characters");
  return value.trim();
}
/** Bypass may be listed but changes nothing: it is always the user's choice. */
function modeList(value: unknown, where: string): PolicyMode[] {
  if (!Array.isArray(value)) fail(where, "must be a list of modes");
  for (const mode of value)
    if (mode !== "bypass" && !policyModes.includes(mode))
      fail(where, `has an unknown mode ${JSON.stringify(mode)}`);
  const modes = policyModes.filter((mode) => value.includes(mode));
  if (!modes.length) fail(where, "must allow a mode other than bypass");
  return modes;
}
const serverName = /^[a-zA-Z0-9_-]{1,64}$/;
function connectorRule(raw: unknown, where: string): ConnectorRule {
  const value = record(raw, where);
  only(value, ["name", "command", "args", "url", "urlPrefix"], where);
  if (typeof value.name !== "string" || !serverName.test(value.name))
    fail(`${where}.name`, "must be an MCP server name");
  if (value.urlPrefix !== undefined) {
    if (value.command !== undefined || value.url !== undefined)
      fail(where, "must have only one of command, url and urlPrefix");
    if (
      typeof value.urlPrefix !== "string" ||
      !/^https:\/\/[^\s]+$/.test(value.urlPrefix) ||
      value.urlPrefix.length > 2000
    )
      fail(`${where}.urlPrefix`, "must be an https address");
    return { name: value.name, urlPrefix: value.urlPrefix };
  }
  if ((value.command === undefined) === (value.url === undefined))
    fail(where, "must have either a command or a url");
  if (value.url !== undefined) {
    if (value.args !== undefined) fail(`${where}.args`, "needs a command");
    if (typeof value.url !== "string" || !/^https?:\/\//.test(value.url))
      fail(`${where}.url`, "must be an http(s) address");
    return { name: value.name, url: value.url };
  }
  if (typeof value.command !== "string" || !value.command.trim())
    fail(`${where}.command`, "must be a program");
  const args = value.args ?? [];
  if (
    !Array.isArray(args) ||
    args.length > 100 ||
    !args.every((arg) => typeof arg === "string")
  )
    fail(`${where}.args`, "must be a list of arguments");
  return { name: value.name, command: value.command, args: args as string[] };
}
const version = (value: unknown, where: string) => {
  if (typeof value !== "string" || !/^\d+(\.\d+){0,3}$/.test(value))
    fail(where, "must be a version such as 1.4.0");
  return value;
};

function parsePatch(raw: unknown, where: string): PolicyPatch {
  const value = record(raw, where);
  only(
    value,
    [
      "permissionModes",
      "scheduledTasks",
      "incognito",
      "webSearch",
      "voice",
      "localMcpEditing",
      "developerModeEnabled",
      "desktopExtensionsEnabled",
      "developerMcpEnabled",
      "remoteImages",
      "externalLinks",
      "connectors",
      "attachments",
      "links",
    ],
    where,
  );
  const patch: PolicyPatch = {};
  if ("scheduledTasks" in value) {
    const tasks = record(value.scheduledTasks, `${where}.scheduledTasks`);
    only(
      tasks,
      ["enabled", "maxTasks", "approvalLifetimeDays"],
      `${where}.scheduledTasks`,
    );
    patch.scheduledTasks = {};
    if ("enabled" in tasks) {
      if (typeof tasks.enabled !== "boolean")
        fail(`${where}.scheduledTasks.enabled`, "must be a boolean");
      patch.scheduledTasks.enabled = tasks.enabled;
    }
    for (const key of ["maxTasks", "approvalLifetimeDays"] as const) {
      if (!(key in tasks)) continue;
      const limit = tasks[key];
      if (key === "maxTasks" && limit === null)
        patch.scheduledTasks.maxTasks = null;
      else {
        if (
          typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 0 ||
          limit > (key === "maxTasks" ? 100 : 36500)
        )
          fail(
            `${where}.scheduledTasks.${key}`,
            "must be a non-negative integer within the limit",
          );
        patch.scheduledTasks[key] = limit;
      }
    }
  }
  if ("permissionModes" in value) {
    const modes = value.permissionModes;
    if (Array.isArray(modes))
      patch.permissionModes = modeList(modes, `${where}.permissionModes`);
    else {
      const byPlatform = record(modes, `${where}.permissionModes`);
      only(byPlatform, ["default", ...platforms], `${where}.permissionModes`);
      patch.permissionModes = Object.fromEntries(
        Object.entries(byPlatform).map(([key, list]) => [
          key,
          modeList(list, `${where}.permissionModes.${key}`),
        ]),
      );
    }
  }
  for (const key of [
    "incognito",
    "webSearch",
    "voice",
    "localMcpEditing",
    "developerModeEnabled",
    "desktopExtensionsEnabled",
    "developerMcpEnabled",
    "remoteImages",
    "externalLinks",
  ] as const)
    if (key in value) patch[key] = boolean(value[key], `${where}.${key}`);
  if ("connectors" in value) {
    const list = value.connectors;
    if (list !== null && (!Array.isArray(list) || list.length > 200))
      fail(`${where}.connectors`, "must be null or a list of MCP servers");
    patch.connectors =
      list === null
        ? null
        : (list as unknown[]).map((item, index) =>
            connectorRule(item, `${where}.connectors[${index}]`),
          );
  }
  if ("attachments" in value) {
    const attachments = record(value.attachments, `${where}.attachments`);
    only(attachments, ["maxMegabytes", "types"], `${where}.attachments`);
    patch.attachments = {};
    if ("maxMegabytes" in attachments) {
      const mb = attachments.maxMegabytes;
      if (mb !== null && !(typeof mb === "number" && mb > 0 && mb <= 20))
        fail(`${where}.attachments.maxMegabytes`, "must be null or 0–20");
      patch.attachments.maxMegabytes = mb as number | null;
    }
    if ("types" in attachments) {
      const types = attachments.types;
      if (!Array.isArray(types))
        fail(`${where}.attachments.types`, "must be a list");
      const lower = types.map((type) =>
        typeof type === "string" ? type.replace(/^\./, "").toLowerCase() : type,
      );
      for (const type of lower)
        if (!attachmentTypes.includes(type as string))
          fail(
            `${where}.attachments.types`,
            `has an unsupported type ${JSON.stringify(type)}`,
          );
      patch.attachments.types = attachmentTypes.filter((type) =>
        lower.includes(type),
      );
    }
  }
  if ("links" in value) {
    const links = record(value.links, `${where}.links`);
    only(links, ["help", "plans", "apps", "learnMore"], `${where}.links`);
    patch.links = {};
    for (const key of ["help", "plans", "apps"] as const)
      if (key in links)
        patch.links[key] = url(links[key], `${where}.links.${key}`);
    if ("learnMore" in links) {
      const list = links.learnMore;
      if (!Array.isArray(list) || list.length > 10)
        fail(`${where}.links.learnMore`, "must be a list of up to 10 links");
      patch.links.learnMore = list.map((item, index) => {
        const entry = record(item, `${where}.links.learnMore[${index}]`);
        only(entry, ["label", "url"], `${where}.links.learnMore[${index}]`);
        return {
          label: label(entry.label, `${where}.links.learnMore[${index}].label`),
          url: url(entry.url, `${where}.links.learnMore[${index}].url`)!,
        };
      });
    }
  }
  return patch;
}

function parseAnnouncement(raw: unknown, index: number): PolicyAnnouncement {
  const where = `announcements[${index}]`;
  const value = record(raw, where);
  only(value, ["id", "title", "content", "popup", "startsAt", "endsAt"], where);
  if (typeof value.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.id))
    fail(`${where}.id`, "must be 1–64 letters, digits, - or _");
  if (
    typeof value.title !== "string" ||
    !value.title.trim() ||
    value.title.length > 200
  )
    fail(`${where}.title`, "must be 1–200 characters");
  if (typeof value.content !== "string" || value.content.length > 20000)
    fail(`${where}.content`, "must be text up to 20000 characters");
  const announcement: PolicyAnnouncement = {
    id: value.id,
    title: value.title.trim(),
    content: value.content,
  };
  if ("popup" in value)
    announcement.popup = boolean(value.popup, `${where}.popup`);
  for (const key of ["startsAt", "endsAt"] as const)
    if (key in value) {
      if (
        typeof value[key] !== "string" ||
        !Number.isFinite(Date.parse(value[key] as string))
      )
        fail(`${where}.${key}`, "must be an ISO date");
      announcement[key] = value[key] as string;
    }
  return announcement;
}

export function parseOperatorPolicy(raw: unknown): OperatorPolicyFile {
  const value = record(raw, "file");
  only(
    value,
    ["version", "defaults", "accounts", "client", "announcements"],
    "file",
  );
  if (value.version !== 1) fail("version", "must be 1");
  const file: OperatorPolicyFile = { version: 1 };
  if ("defaults" in value)
    file.defaults = parsePatch(value.defaults, "defaults");
  if ("accounts" in value)
    file.accounts = Object.fromEntries(
      Object.entries(record(value.accounts, "accounts")).map(([id, patch]) => [
        id,
        parsePatch(patch, `accounts.${JSON.stringify(id)}`),
      ]),
    );
  if ("client" in value) {
    const client = record(value.client, "client");
    only(client, ["latestVersion", "minimumVersion", "downloadUrl"], "client");
    file.client = {};
    for (const key of ["latestVersion", "minimumVersion"] as const)
      if (key in client)
        file.client[key] = version(client[key], `client.${key}`);
    if ("downloadUrl" in client)
      file.client.downloadUrl =
        url(client.downloadUrl, "client.downloadUrl") ?? undefined;
  }
  if ("announcements" in value) {
    if (!Array.isArray(value.announcements) || value.announcements.length > 50)
      fail("announcements", "must be a list of up to 50 notices");
    file.announcements = value.announcements.map(parseAnnouncement);
    if (
      new Set(file.announcements.map((item) => item.id)).size !==
      file.announcements.length
    )
      fail("announcements", "must have unique ids");
  }
  return file;
}

export const policyFileName = (root: string) =>
  path.join(root, "backend", "policy.json");

/** Undefined without a file; throws when the file exists but is not valid. */
export function loadOperatorPolicy(
  root: string,
): OperatorPolicyFile | undefined {
  let text: string;
  try {
    text = fs.readFileSync(policyFileName(root), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw Error("Claudex policy: the file cannot be read.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Error("Claudex policy: the file is not valid JSON.");
  }
  return parseOperatorPolicy(parsed);
}

export interface PolicyContext {
  platform: NodeJS.Platform;
  appVersion: string;
  /** The local account. */
  accountId: string;
}

function apply(
  policy: ClientPolicy,
  patch: PolicyPatch | undefined,
  platform: NodeJS.Platform,
) {
  const next: ClientPolicy = {
    ...policy,
    permissionModes: [...policy.permissionModes],
    attachments: { ...policy.attachments },
    links: { ...policy.links, learnMore: [...policy.links.learnMore] },
  };
  if (!patch) return next;
  if (patch.scheduledTasks)
    next.scheduledTasks = { ...policy.scheduledTasks, ...patch.scheduledTasks };
  const modes = patch.permissionModes;
  if (Array.isArray(modes)) next.permissionModes = modes;
  else if (modes) {
    const list = modes[platform as Platform] ?? modes.default;
    if (list) next.permissionModes = list;
  }
  for (const key of [
    "incognito",
    "webSearch",
    "voice",
    "localMcpEditing",
    "developerModeEnabled",
    "desktopExtensionsEnabled",
    "developerMcpEnabled",
    "remoteImages",
    "externalLinks",
  ] as const)
    if (patch[key] !== undefined) next[key] = patch[key]!;
  if (patch.connectors !== undefined) next.connectors = patch.connectors;
  if (patch.attachments?.maxMegabytes !== undefined)
    next.attachments.maxBytes =
      patch.attachments.maxMegabytes === null
        ? null
        : Math.round(patch.attachments.maxMegabytes * 1024 * 1024);
  if (patch.attachments?.types)
    next.attachments.types = patch.attachments.types;
  for (const key of ["help", "plans", "apps"] as const)
    if (patch.links?.[key] !== undefined) {
      if (patch.links[key]) next.links[key] = patch.links[key]!;
      else delete next.links[key];
    }
  if (patch.links?.learnMore) next.links.learnMore = patch.links.learnMore;
  return next;
}

/**
 * A local account's policy: the file's defaults, then the account's own
 * overrides. Without a file nothing is restricted (it is the operator's own
 * computer); a file that cannot be read locks optional features instead.
 */
export function resolveClientPolicy(
  file: OperatorPolicyFile | undefined,
  context: PolicyContext,
): ClientPolicy {
  let policy = apply(openPolicy, file?.defaults, context.platform);
  policy = apply(policy, file?.accounts?.[context.accountId], context.platform);
  const update = file?.client && clientUpdate(context.appVersion, file.client);
  return update ? { ...policy, update } : policy;
}

/** The file's policy, or the locked one when the file is broken. */
export function currentClientPolicy(root: string, context: PolicyContext) {
  try {
    return resolveClientPolicy(loadOperatorPolicy(root), context);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return structuredClone(lockedPolicy);
  }
}

/** Local accounts' notices from the file, current at `now`. */
export function fileAnnouncements(
  file: OperatorPolicyFile | undefined,
  now: number,
) {
  return (file?.announcements ?? []).filter(
    (item) =>
      (!item.startsAt || Date.parse(item.startsAt) <= now) &&
      (!item.endsAt || Date.parse(item.endsAt) > now),
  );
}
