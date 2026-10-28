import fs from "node:fs/promises";
import path from "node:path";
import type { Conversation } from "../../shared/types";
import type { StorageUsage } from "../../shared/settings-desktop-api";

/**
 * Settings → System → Storage: what Claudex keeps on this computer, measured on
 * disk in the official four areas, and what each conversation takes (the
 * cleanups in storage-cleanup.ts free exactly that).
 */

/** Sizes on disk; links are never followed and anything unreadable is remembered. */
export class DiskMeasure {
  /** A folder or file couldn't be read: the sizes are a lower bound. */
  incomplete = false;
  async bytes(target: string): Promise<number> {
    let stat;
    try {
      stat = await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.incomplete = true;
      return 0;
    }
    if (!stat.isDirectory()) return stat.isFile() ? stat.size : 0;
    let entries: string[];
    try {
      entries = await fs.readdir(target);
    } catch {
      this.incomplete = true;
      return 0;
    }
    let total = 0;
    for (const name of entries)
      total += await this.bytes(path.join(target, name));
    return total;
  }
  /** Each entry of a folder with its size (none when the folder is missing). */
  async children(folder: string): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    let entries: string[];
    try {
      entries = await fs.readdir(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.incomplete = true;
      return sizes;
    }
    for (const name of entries)
      sizes.set(name, await this.bytes(path.join(folder, name)));
    return sizes;
  }
}

/** Bytes under a file or folder; links are not followed and unreadable entries count as 0. */
export async function diskUsage(target: string): Promise<number> {
  return new DiskMeasure().bytes(target);
}

/** Where computer use keeps each conversation's screenshots (R10). */
export const screenshotFolder = (root: string) =>
  path.join(root, "computer-use", "screenshots");

/** The agent runtime's session history folders (Codex's CODEX_HOME). */
export const sessionFolders = ["sessions", "archived_sessions"];

/** A thread's history file: `rollout-<time>-<thread id>.jsonl`. */
const rolloutName =
  /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export interface RolloutFile {
  path: string;
  bytes: number;
  /** Last change on this computer (ctime: copying or restoring a file sets it too). */
  changedAt: number;
}

/** Every thread's history files under the runtime's home, by thread id. */
export async function rolloutIndex(
  codexHome: string,
  measure = new DiskMeasure(),
): Promise<Map<string, RolloutFile[]>> {
  const index = new Map<string, RolloutFile[]>();
  const walk = async (folder: string, depth: number) => {
    let entries;
    try {
      entries = await fs.readdir(folder, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        measure.incomplete = true;
      return;
    }
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        // sessions/<year>/<month>/<day>/
        if (depth < 4) await walk(full, depth + 1);
        continue;
      }
      const thread = entry.isFile() && rolloutName.exec(entry.name)?.[1];
      if (!thread) continue;
      try {
        const stat = await fs.lstat(full);
        const files = index.get(thread.toLowerCase()) ?? [];
        files.push({ path: full, bytes: stat.size, changedAt: stat.ctimeMs });
        index.set(thread.toLowerCase(), files);
      } catch {
        measure.incomplete = true;
      }
    }
  };
  for (const folder of sessionFolders)
    await walk(path.join(codexHome, folder), 0);
  return index;
}

/** The threads a conversation's history lives in: its own and its saved branches'. */
export function conversationThreads(conversation: Conversation): string[] {
  return [
    ...new Set(
      [
        conversation.threadId,
        ...(conversation.savedBranches ?? []).map((branch) => branch.threadId),
      ]
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .map((id) => id.toLowerCase()),
    ),
  ];
}

/** Attachment copies live in `<profile>/attachments/<id>/<file>`. */
const attachmentFolderName = /^[0-9a-f-]{8,64}$/i;

/** The attachment folders under the profile a conversation's messages use. */
export function conversationAttachments(
  root: string,
  conversation: Conversation,
): string[] {
  const folder = path.resolve(root, "attachments");
  const names = new Set<string>();
  const turns = [
    conversation.turns,
    ...(conversation.savedBranches ?? []).map((branch) => branch.turns),
  ].flat();
  for (const turn of turns)
    for (const attachment of turn?.attachments ?? []) {
      if (typeof attachment?.path !== "string") continue;
      const relative = path.relative(folder, path.resolve(attachment.path));
      const [name] = relative.split(path.sep);
      if (
        name &&
        !path.isAbsolute(relative) &&
        name !== ".." &&
        attachmentFolderName.test(name)
      )
        names.add(name);
    }
  return [...names];
}

/** The generated-file snapshots (by digest) a conversation shows. */
export function conversationDigests(record: string): string[] {
  return [
    ...new Set(
      [...record.matchAll(/"digest":\s*"([0-9a-f]{64})"/g)].map(
        (match) => match[1],
      ),
    ),
  ];
}

/** When a conversation was last used: its newest change or message. */
export function lastActivityAt(conversation: Conversation): number {
  let latest = Math.max(
    Number(conversation.updatedAt) || 0,
    Number(conversation.createdAt) || 0,
  );
  for (const turn of conversation.turns ?? [])
    latest = Math.max(latest, Number(turn?.createdAt) || 0);
  return latest;
}

/**
 * The disk space of each saved conversation and what it shares. Records are
 * their share of conversations.json; attachment folders and snapshots are
 * listed by who uses them, so a cleanup frees one only when every
 * conversation using it goes.
 */
export interface ConversationSpace {
  /** Record, history, screenshots: freed when the conversation goes. */
  own: Map<string, number>;
  /** History files by conversation. */
  rollouts: Map<string, RolloutFile[]>;
  attachmentUsers: Map<string, Set<string>>;
  attachmentBytes: Map<string, number>;
  digestUsers: Map<string, Set<string>>;
  digestBytes: Map<string, number>;
  /** Computer use screenshots by conversation folder. */
  screenshotBytes: Map<string, number>;
}

export async function conversationSpace(
  root: string,
  conversations: readonly Conversation[],
  measure = new DiskMeasure(),
  index?: Map<string, RolloutFile[]>,
): Promise<ConversationSpace> {
  const saved = conversations.filter((c) => !c.incognito);
  const rolloutsByThread =
    index ?? (await rolloutIndex(path.join(root, "codex-home"), measure));
  const records = saved.map((c) => JSON.stringify(c));
  // conversations.json is written indented: each record takes its share.
  let fileBytes = 0;
  try {
    fileBytes = (await fs.lstat(path.join(root, "conversations.json"))).size;
  } catch {
    // Nothing saved yet.
  }
  const plain = records.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
  const attachmentBytes = await measure.children(
    path.join(root, "attachments"),
  );
  const digestBytes = await measure.children(
    path.join(root, "generated-files"),
  );
  const shots = await measure.children(screenshotFolder(root));
  const space: ConversationSpace = {
    own: new Map(),
    rollouts: new Map(),
    attachmentUsers: new Map(),
    attachmentBytes,
    digestUsers: new Map(),
    digestBytes,
    screenshotBytes: shots,
  };
  saved.forEach((conversation, i) => {
    const record = plain
      ? Math.round((fileBytes * Buffer.byteLength(records[i])) / plain)
      : 0;
    const rollouts = conversationThreads(conversation).flatMap(
      (thread) => rolloutsByThread.get(thread) ?? [],
    );
    space.rollouts.set(conversation.id, rollouts);
    space.own.set(
      conversation.id,
      record +
        rollouts.reduce((sum, file) => sum + file.bytes, 0) +
        (shots.get(conversation.id) ?? 0),
    );
    for (const name of conversationAttachments(root, conversation)) {
      const users = space.attachmentUsers.get(name) ?? new Set();
      users.add(conversation.id);
      space.attachmentUsers.set(name, users);
    }
    for (const digest of conversationDigests(records[i])) {
      const users = space.digestUsers.get(digest) ?? new Set();
      users.add(conversation.id);
      space.digestUsers.set(digest, users);
    }
  });
  return space;
}

/** Space deleting these conversations frees: theirs, and files only they use. */
export function freedBytes(
  space: ConversationSpace,
  ids: ReadonlySet<string>,
): number {
  let total = 0;
  for (const id of ids) total += space.own.get(id) ?? 0;
  const onlyTheirs = (users: Set<string>) =>
    [...users].every((user) => ids.has(user));
  for (const [name, users] of space.attachmentUsers)
    if (onlyTheirs(users)) total += space.attachmentBytes.get(name) ?? 0;
  for (const [digest, users] of space.digestUsers)
    if (onlyTheirs(users)) total += space.digestBytes.get(digest) ?? 0;
  return total;
}

/**
 * Cleanup can select a conversation: saved, on this computer, not pinned,
 * nothing running, and no activity for `days` days. Chat and Cowork are the
 * Cowork tasks; Code its sessions.
 */
export function cleanupEligible(
  conversation: Conversation,
  kind: "cowork" | "code",
  days: number,
  now: number,
): boolean {
  if (conversation.incognito || conversation.pinned) return false;
  if ((conversation.mode === "code") !== (kind === "code")) return false;
  if (conversation.environment && conversation.environment.kind !== "local")
    return false;
  if (conversation.turns?.some((turn) => turn.status === "inProgress"))
    return false;
  const at = lastActivityAt(conversation);
  return at > 0 && now - at > days * dayMs;
}

export const dayMs = 24 * 60 * 60 * 1000;
/** The main dialog's "no activity in the last 30 days". */
export const staleDays = 30;

/** The web caches Chromium keeps in userData. */
const webCacheFolders = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
];
/** Other caches in userData: update downloads and HTTP compression dictionaries. */
const otherCacheFolders = ["updates", "Shared Dictionary"];
/** Codex downloaded for SSH hosts: `codex-<version>-<target>.tgz`. */
const runtimeDownload = /^codex-(\d[^-]*)-.+\.(?:tgz|tar\.gz|zip)$/;

export interface StorageInput {
  /** The signed-in account's profile folder. */
  root: string;
  /** userData: web caches, browser panes, runtime downloads. */
  dataRoot: string;
  conversations: readonly Conversation[];
  /** The app's log and crash report folders. */
  logFolders?: string[];
  now?: number;
}

/** How much space Claudex uses on this computer, by area. */
export async function storageUsage(input: StorageInput): Promise<StorageUsage> {
  const { root, dataRoot } = input;
  const now = input.now ?? Date.now();
  const measure = new DiskMeasure();
  const home = path.join(root, "codex-home");
  const saved = input.conversations.filter((c) => !c.incognito);
  const space = await conversationSpace(root, saved, measure);
  const isCode = new Map(saved.map((c) => [c.id, c.mode === "code"]));
  const area = { cowork: 0, code: 0 };
  const coworkFiles = { value: 0 };
  for (const conversation of saved) {
    const own = space.own.get(conversation.id) ?? 0;
    if (conversation.mode === "code") area.code += own;
    else area.cowork += own;
  }
  // A shared file counts once, in the area of its first user.
  const shared = (
    users: Map<string, Set<string>>,
    sizes: Map<string, number>,
  ) => {
    for (const [name, ids] of users) {
      const bytes = sizes.get(name) ?? 0;
      if (isCode.get([...ids][0])) area.code += bytes;
      else coworkFiles.value += bytes;
    }
  };
  shared(space.attachmentUsers, space.attachmentBytes);
  shared(space.digestUsers, space.digestBytes);
  // Screenshots are part of `own`; the Cowork area lists them as files.
  let coworkShots = 0;
  for (const [id, bytes] of space.screenshotBytes)
    if (isCode.get(id) === false) coworkShots += bytes;
  const generatedImages = await measure.bytes(
    path.join(home, "generated_images"),
  );
  const coworkHistory = area.cowork - coworkShots;
  const coworkFilesBytes = coworkFiles.value + coworkShots + generatedImages;
  const pluginsAndSkills =
    (await measure.bytes(path.join(home, "skills"))) +
    (await measure.bytes(path.join(home, "plugins")));
  // The account folder is walked once: the work folders (which can be
  // large) are its top-level entries.
  const top = await measure.children(root);
  const workspace = top.get("workspace") ?? 0;
  const scratch = top.get("terminal-workspace") ?? 0;
  let profileLogs = await measure.bytes(path.join(home, "log"));
  for (const name of (await fs.readdir(home).catch(() => [])) as string[])
    if (/^logs_\d+\.sqlite/.test(name))
      profileLogs += await measure.bytes(path.join(home, name));
  const profile = [...top.values()].reduce((sum, bytes) => sum + bytes, 0);
  const attributed =
    area.cowork +
    area.code +
    coworkFiles.value +
    generatedImages +
    pluginsAndSkills +
    workspace +
    scratch +
    profileLogs;
  // Settings, projects, memory, usage records and history no conversation
  // uses any more: the rest of the account's folder.
  const other = Math.max(0, profile - attributed);

  const stale = saved.filter((c) =>
    cleanupEligible(c, "cowork", staleDays, now),
  );

  let webCache = 0;
  for (const name of webCacheFolders)
    webCache += await measure.bytes(path.join(dataRoot, name));
  let otherCaches = 0;
  for (const name of otherCacheFolders)
    otherCaches += await measure.bytes(path.join(dataRoot, name));
  let appLogs = profileLogs;
  for (const folder of input.logFolders ?? [])
    appLogs += await measure.bytes(folder);
  const runtimeFolder = path.join(dataRoot, "runtime-cache");
  const downloads = await measure.children(runtimeFolder);
  const versions = new Set(
    [...downloads.keys()]
      .map((name) => runtimeDownload.exec(name)?.[1])
      .filter(Boolean),
  );
  return {
    computedAt: now,
    incomplete: measure.incomplete,
    folder: root,
    cowork: {
      count: saved.filter((c) => c.mode !== "code").length,
      chatCount: saved.filter((c) => c.mode === "chat").length,
      historyBytes: Math.max(0, coworkHistory),
      filesBytes: coworkFilesBytes,
      pluginsAndSkillsBytes: pluginsAndSkills,
      workspaceBytes: workspace,
      otherBytes: other,
      stale: {
        olderThanDays: staleDays,
        count: stale.length,
        bytes: freedBytes(space, new Set(stale.map((c) => c.id))),
      },
    },
    code: {
      sessionCount: saved.filter((c) => c.mode === "code").length,
      historyBytes: area.code,
      scratchBytes: scratch,
    },
    runtime: {
      versionCount: versions.size,
      bytes: [...downloads.values()].reduce((sum, bytes) => sum + bytes, 0),
    },
    app: {
      webCacheBytes: webCache,
      browserPanesBytes: await measure.bytes(path.join(dataRoot, "Partitions")),
      logsBytes: appLogs,
      otherCachesBytes: otherCaches,
    },
  };
}
