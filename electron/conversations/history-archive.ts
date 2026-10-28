import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { claudeConversation, claudeProject } from "./claude-transcripts";
import type { Conversation, Project } from "../../shared/types";
import type {
  HistoryImportRun,
  HistorySourceProblem,
} from "../../shared/history-import";

/** The part of the store an import reads and changes. */
export interface HistoryStore {
  readonly root: string;
  conversations: Conversation[];
  projects: Project[];
  flush(): void;
}

/** A location the person added, as it is kept in the profile. */
export interface SourceEntry {
  id: string;
  kind: "file" | "folder";
  path: string;
  addedAt: number;
}

/** An import run with the ids it added, as it is kept in the profile. */
export interface RunEntry extends HistoryImportRun {
  conversationIds: string[];
  projectIds: string[];
}

export const sourcesFile = "import-sources.json";

export const historyFile = "import-history.json";

/** An export larger than this is not read (the original also has a size limit). */
const maxArchiveBytes = 1024 * 1024 * 1024;

/** One file of an export, once unpacked. */
const maxFileBytes = 512 * 1024 * 1024;

export const maxSources = 50;

/** Raised for a location that cannot be used; the window words it. */
export class HistorySourceError extends Error {
  constructor(readonly problem: HistorySourceProblem) {
    super(problem);
  }
}

const idPattern = /^[A-Za-z0-9_.:-]{1,200}$/;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export const isDirectory = (folder: string) => {
  try {
    return fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
};

/**
 * A conversation of another computer as this one keeps it, or undefined when
 * the record is not one. What belonged to the other computer is left behind:
 * the engine's thread (the next message starts a new one), the machine it ran
 * on, its place in that sidebar, an unread mark and a working folder that is
 * not here. Turns that were running when it was saved read as stopped.
 */
export function importedConversation(raw: unknown): Conversation | undefined {
  const c = record(raw);
  if (
    !c ||
    typeof c.id !== "string" ||
    !idPattern.test(c.id) ||
    typeof c.title !== "string" ||
    !["chat", "cowork", "code"].includes(c.mode as string) ||
    !Array.isArray(c.turns) ||
    typeof c.createdAt !== "number" ||
    typeof c.updatedAt !== "number" ||
    !Number.isFinite(c.updatedAt) ||
    c.incognito === true
  )
    return undefined;
  if (!c.turns.every((turn) => record(turn))) return undefined;
  const copy = structuredClone(c) as Record<string, unknown>;
  if (copy.sessionAuthors !== undefined) {
    const authors = record(copy.sessionAuthors);
    if (
      !authors ||
      ![authors.viewerAccountUuid, authors.ownerAccountUuid].every(
        (value) => typeof value === "string" && idPattern.test(value),
      )
    )
      delete copy.sessionAuthors;
  }
  for (const key of [
    "threadId",
    "environment",
    "sidebarRank",
    "unread",
    "slim",
    "incognito",
    "rewind",
  ])
    delete copy[key];
  if (typeof copy.cwd !== "string" || !isDirectory(copy.cwd)) delete copy.cwd;
  const stopped = (turns: unknown) =>
    (turns as Record<string, unknown>[]).map((turn) =>
      turn.status === "inProgress" ? { ...turn, status: "interrupted" } : turn,
    );
  copy.turns = stopped(copy.turns);
  if (Array.isArray(copy.savedBranches))
    copy.savedBranches = copy.savedBranches.flatMap((branch) => {
      const b = record(branch);
      if (!b || !Array.isArray(b.turns)) return [];
      const { threadId: _thread, ...rest } = b;
      return [{ ...rest, turns: stopped(b.turns) }];
    });
  return {
    pinned: false,
    archived: false,
    providerId: "",
    model: "",
    ...copy,
  } as unknown as Conversation;
}

/** A project of another computer, or undefined when the record is not one. */
export function importedProject(raw: unknown): Project | undefined {
  const p = record(raw);
  if (
    !p ||
    typeof p.id !== "string" ||
    !idPattern.test(p.id) ||
    typeof p.name !== "string" ||
    !p.name.trim()
  )
    return undefined;
  return {
    id: p.id,
    name: p.name.slice(0, 100),
    description: typeof p.description === "string" ? p.description : "",
    instructions: typeof p.instructions === "string" ? p.instructions : "",
    ...(typeof p.cwd === "string" && isDirectory(p.cwd) ? { cwd: p.cwd } : {}),
    createdAt: typeof p.createdAt === "number" ? p.createdAt : 0,
  };
}

/** The folders of a copied data folder that hold a profile's files. */
export function profileFolders(folder: string): string[] {
  const holds = (candidate: string) =>
    fs.existsSync(path.join(candidate, "conversations.json"));
  if (holds(folder)) return [folder];
  const children = (parent: string) => {
    try {
      return fs
        .readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => path.join(parent, entry.name));
    } catch {
      return [];
    }
  };
  // The app's data folder keeps each account's files in profiles/<account>.
  const profiles = children(path.join(folder, "profiles")).filter(holds);
  if (profiles.length) return profiles;
  // A folder that holds the data folder (a backup of the whole user folder).
  return children(folder).flatMap((child) =>
    holds(child)
      ? [child]
      : children(path.join(child, "profiles")).filter(holds),
  );
}

export interface SourceData {
  conversations: Conversation[];
  projects: Project[];
}

function parseList(text: string): unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HistorySourceError("unreadable");
  }
  if (!Array.isArray(value)) throw new HistorySourceError("unknown-shape");
  return value;
}

/** What an export (.zip) holds: its conversations.json and projects.json. */
async function readArchive(file: string): Promise<SourceData> {
  if (fs.statSync(file).size > maxArchiveBytes)
    throw new HistorySourceError("unreadable");
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(fs.readFileSync(file));
  } catch {
    throw new HistorySourceError("unreadable");
  }
  const find = (name: string) =>
    zip.file(name) ??
    Object.values(zip.files).find(
      (entry) => !entry.dir && entry.name.split("/").at(-1) === name,
    ) ??
    null;
  const text = async (name: string) => {
    const entry = find(name);
    if (!entry) return undefined;
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })
      ._data?.uncompressedSize;
    if (typeof size === "number" && size > maxFileBytes)
      throw new HistorySourceError("unreadable");
    return entry.async("string");
  };
  const conversations = await text("conversations.json");
  const projects = await text("projects.json");
  const projectFiles = Object.values(zip.files).filter(
    (entry) => !entry.dir && /^projects\/[^/]+\.json$/.test(entry.name),
  );
  if (
    conversations === undefined &&
    projects === undefined &&
    !projectFiles.length
  )
    throw new HistorySourceError("unknown-shape");
  const individualProjects: unknown[] = [];
  for (const entry of projectFiles) {
    const content = await text(entry.name);
    if (content) {
      try {
        individualProjects.push(JSON.parse(content));
      } catch {
        throw new HistorySourceError("unreadable");
      }
    }
  }
  return collect(conversations === undefined ? [] : parseList(conversations), [
    ...(projects === undefined ? [] : parseList(projects)),
    ...individualProjects,
  ]);
}

/** What a copied data folder holds, from every profile in it. */
function readFolder(folder: string): SourceData {
  const profiles = profileFolders(folder);
  if (!profiles.length) throw new HistorySourceError("unknown-shape");
  const conversations: unknown[] = [];
  const projects: unknown[] = [];
  for (const profile of profiles) {
    const read = (name: string) => {
      const file = path.join(profile, name);
      if (!fs.existsSync(file)) return [];
      if (fs.statSync(file).size > maxFileBytes)
        throw new HistorySourceError("unreadable");
      return parseList(fs.readFileSync(file, "utf8"));
    };
    conversations.push(...read("conversations.json"));
    projects.push(...read("projects.json"));
  }
  return collect(conversations, projects);
}

/** The valid records of a source, the first of an id kept. */
function collect(conversations: unknown[], projects: unknown[]): SourceData {
  const pick = <T extends { id: string }>(
    list: unknown[],
    convert: (raw: unknown) => T | undefined,
  ) => {
    const seen = new Set<string>();
    return list.flatMap((raw) => {
      const item = convert(raw);
      if (!item || seen.has(item.id)) return [];
      seen.add(item.id);
      return [item];
    });
  };
  return {
    conversations: pick(
      conversations,
      (raw) => importedConversation(raw) ?? claudeConversation(raw),
    ),
    projects: pick(
      projects,
      (raw) => importedProject(raw) ?? claudeProject(raw),
    ),
  };
}

/** A location's contents by path, until the file changes. */
export const cache = new Map<string, { signature: string; data: SourceData }>();

const signature = (target: string) => {
  const stat = fs.statSync(target);
  return `${stat.mtimeMs}:${stat.size}`;
};

export async function readSource(entry: SourceEntry): Promise<SourceData> {
  let sig: string;
  try {
    sig = signature(entry.path);
  } catch {
    throw new HistorySourceError("unreadable");
  }
  const cached = cache.get(entry.path);
  if (cached?.signature === sig) return cached.data;
  const data =
    entry.kind === "file"
      ? await readArchive(entry.path)
      : readFolder(entry.path);
  // Only the last few locations stay in memory.
  cache.delete(entry.path);
  cache.set(entry.path, { signature: sig, data });
  while (cache.size > 3) cache.delete(cache.keys().next().value!);
  return data;
}

/** Forgets what was read (after a run the conversations belong to the store). */
export function forgetReadHistory() {
  cache.clear();
}
