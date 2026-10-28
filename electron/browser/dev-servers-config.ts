import fs from "node:fs";
import path from "node:path";
import type {
  DevServerState,
  DevServerStatus,
  LaunchConfiguration,
} from "../../shared/browser";
import {
  formatCommandLine,
  launchCommandKey,
  launchConfigFallbackPath,
  launchConfigPath,
  launchLimits,
  launchPort,
  launchUrl,
  parseLaunchConfig,
  upsertLaunchConfig,
  setLaunchAutoVerify,
  type LaunchEntry,
  type LaunchParseResult,
} from "../../shared/launch-config";
import { detectDevServers } from "./dev-server-detect";
import { lower, errorText } from "./dev-server-support";
import type { DevServers } from "./dev-servers";
import type { ConfigCache } from "./dev-servers";

// ---- The folder and its launch.json ----

/** The session's folder (real path), or the reason there are no dev servers. */
export function folder(
  this: DevServers,
  conversationId: string,
): { folder?: string; error?: string } {
  const conversation = this.deps.conversation(conversationId);
  if (!conversation) return { error: "This conversation doesn't exist." };
  if (conversation.remote)
    return {
      error:
        "Dev servers run on this computer. This session runs on a remote host.",
    };
  if (!conversation.cwd)
    return { error: "Choose a folder for this session to add dev servers." };
  try {
    const real = fs.realpathSync(conversation.cwd);
    if (!fs.statSync(real).isDirectory())
      return { error: "This session's folder isn't a folder." };
    return { folder: real };
  } catch {
    return { error: "This session's folder can't be found." };
  }
}

/** `file` resolved stays inside `folder` (no link out of the project). */
export function inside(this: DevServers, folder: string, file: string) {
  const relative = path.relative(folder, file);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function readConfig(
  this: DevServers,
  conversationId: string,
): ConfigCache & {
  folder?: string;
} {
  const { folder, error } = this.folder(conversationId);
  if (!folder)
    return {
      result: { configurations: [], extra: {}, invalid: [] },
      folderError: error,
    };
  const cached = this.configs.get(folder);
  let file: string | undefined;
  let stamp: string | undefined;
  for (const relative of [launchConfigPath, launchConfigFallbackPath]) {
    const candidate = path.join(folder, relative);
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      file = candidate;
      stamp = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
      break;
    } catch {
      // Not there.
    }
  }
  this.watch(folder);
  if (cached && cached.file === file && cached.stamp === stamp)
    return { ...cached, folder };
  let result: LaunchParseResult = {
    configurations: [],
    extra: {},
    invalid: [],
  };
  if (file) {
    try {
      const real = fs.realpathSync(file);
      if (!this.inside(folder, real))
        result.error = "launch.json must be inside this session's folder.";
      else if (fs.statSync(real).size > launchLimits.fileBytes)
        result.error = "launch.json is too large.";
      else result = parseLaunchConfig(fs.readFileSync(real, "utf8"));
    } catch (error) {
      result.error = `launch.json can't be read (${errorText(error)}).`;
    }
  }
  const next: ConfigCache = { file, stamp, result };
  this.configs.set(folder, next);
  return { ...next, folder };
}

/** Watches `.claude` and `.claudex` so edits by hand or by Claude show at once. */
export function watch(this: DevServers, folder: string) {
  if (this.disposed) return;
  // The folder itself, so a `.claude` created later (by Claude) is seen.
  if (!this.watchers.has(folder))
    try {
      const watcher = fs.watch(folder, { persistent: false }, (_, file) => {
        const name = file ? String(file) : "";
        if (name && name !== ".claude" && name !== ".claudex") return;
        // Created, removed or replaced: watch the folder that is there now.
        for (const dir of name ? [name] : [".claude", ".claudex"]) {
          const target = path.join(folder, dir);
          this.watchers.get(target)?.close();
          this.watchers.delete(target);
        }
        this.configs.delete(folder);
        this.watch(folder);
        for (const id of this.conversationsIn(folder)) this.emit(id);
      });
      watcher.on("error", () => {
        watcher.close();
        this.watchers.delete(folder);
      });
      this.watchers.set(folder, watcher);
    } catch {
      // Not watchable: the panel still reads the file when it refreshes.
    }
  for (const dir of [".claude", ".claudex"]) {
    const target = path.join(folder, dir);
    if (this.watchers.has(target)) continue;
    try {
      if (!fs.statSync(target).isDirectory()) continue;
      const watcher = fs.watch(target, { persistent: false }, () => {
        this.configs.delete(folder);
        for (const id of this.conversationsIn(folder)) this.emit(id);
      });
      watcher.on("error", () => {
        watcher.close();
        this.watchers.delete(target);
      });
      this.watchers.set(target, watcher);
    } catch {
      // No folder yet: saving creates it and watches then.
    }
  }
}

/** Conversations with servers, approvals or listings in `folder`. */
export function conversationsIn(this: DevServers, folder: string) {
  const ids = new Set<string>([
    ...this.records.keys(),
    ...this.approvals.keys(),
    ...this.detected.keys(),
    ...this.asked,
  ]);
  return [...ids].filter((id) => this.folder(id).folder === folder);
}

export function launchConfig(
  this: DevServers,
  conversationId: string,
): { path?: string; error?: string } {
  this.asked.add(conversationId);
  const config = this.readConfig(conversationId);
  const error = config.folderError ?? config.result.error;
  return {
    ...(config.file ? { path: config.file } : {}),
    ...(error ? { error } : {}),
  };
}

/** The configurations in the session's launch.json. */
export function configurations(
  this: DevServers,
  conversationId: string,
): LaunchEntry[] {
  return this.readConfig(conversationId).result.configurations.map((entry) =>
    structuredClone(entry),
  );
}

export function list(
  this: DevServers,
  conversationId: string,
): DevServerState[] {
  this.asked.add(conversationId);
  const config = this.readConfig(conversationId);
  const records = this.records.get(conversationId) ?? new Map();
  const states: DevServerState[] = [];
  const listed = new Set<string>();
  for (const entry of config.result.configurations) {
    const key = lower(entry.name);
    listed.add(key);
    const record = records.get(key);
    states.push(record ? this.state(record) : this.idleState(entry, "stopped"));
  }
  // Running servers whose configuration was removed or renamed can still be stopped.
  for (const [key, record] of records)
    if (!listed.has(key) && record.status !== "stopped") {
      listed.add(key);
      states.push(this.state(record));
    }
  const ports = new Set(
    states
      .filter(
        (state) => state.status === "running" || state.status === "starting",
      )
      .map((state) => state.port),
  );
  for (const detected of this.detected.get(conversationId)?.values() ?? [])
    if (detected.open && !ports.has(detected.port)) {
      ports.add(detected.port);
      states.push({
        name: new URL(detected.url).host,
        command: "",
        port: detected.port,
        url: detected.url,
        status: "running",
        source: "detected-output",
      });
    }
  return states;
}

export function idleState(
  this: DevServers,
  entry: LaunchEntry,
  status: DevServerStatus,
) {
  const state: DevServerState = {
    name: entry.name,
    command: entry.runtimeExecutable
      ? formatCommandLine(entry.runtimeExecutable, entry.runtimeArgs)
      : "",
    status,
    source: "launch.json",
  };
  const port = launchPort(entry);
  const url = launchUrl(entry);
  if (port) state.port = port;
  if (url) state.url = url;
  return state;
}

export async function detect(
  this: DevServers,
  conversationId: string,
): Promise<LaunchConfiguration[]> {
  const { folder, error } = this.folder(conversationId);
  if (!folder) throw new Error(error);
  const drafts = await detectDevServers(folder, { platform: this.platform });
  // Commands already in launch.json aren't proposed again; names stay unique.
  const existing = this.configurations(conversationId);
  const keys = new Set(existing.map((entry) => launchCommandKey("", entry)));
  const names = new Set(existing.map((entry) => lower(entry.name)));
  return drafts
    .filter((draft) => !keys.has(launchCommandKey("", draft)))
    .map((draft) => {
      let name = draft.name;
      for (let n = 2; names.has(lower(name)); n++) name = `${draft.name} ${n}`;
      names.add(lower(name));
      return { ...draft, name };
    });
}

/** Adds or replaces a configuration in the folder's `.claude/launch.json`. */
export async function save(
  this: DevServers,
  conversationId: string,
  config: LaunchConfiguration,
) {
  const current = this.readConfig(conversationId);
  if (!current.folder) throw new Error(current.folderError);
  const folder = current.folder;
  if (current.result.error && current.file) {
    const unreadable =
      current.result.configurations.length === 0 &&
      current.result.invalid.length === 0;
    if (unreadable)
      throw new Error(
        `${current.result.error} Fix the file before adding a server.`,
      );
  }
  this.writeConfig(
    conversationId,
    folder,
    upsertLaunchConfig(current.result, config),
  );
}

/** Saves the project's Auto-verify choice in `.claude/launch.json`. */
export async function setAutoVerify(
  this: DevServers,
  conversationId: string,
  on: boolean,
) {
  const current = this.readConfig(conversationId);
  if (!current.folder) throw new Error(current.folderError);
  if (
    current.result.error &&
    current.file &&
    current.result.configurations.length === 0 &&
    current.result.invalid.length === 0
  )
    throw new Error(`${current.result.error} Fix the file first.`);
  this.writeConfig(
    conversationId,
    current.folder,
    setLaunchAutoVerify(current.result, on),
  );
}

/** Writes the folder's `.claude/launch.json` in one step. */
export function writeConfig(
  this: DevServers,
  conversationId: string,
  folder: string,
  text: string,
) {
  const dir = path.join(folder, ".claude");
  fs.mkdirSync(dir, { recursive: true });
  const realDir = fs.realpathSync(dir);
  if (!this.inside(folder, realDir))
    throw new Error(".claude must be a folder inside this session's folder.");
  const target = path.join(realDir, "launch.json");
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error(".claude/launch.json must be a plain file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = path.join(
    realDir,
    `.launch.json.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(temporary, text, { mode: 0o644 });
  try {
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  this.configs.delete(folder);
  this.watch(folder);
  for (const id of new Set([conversationId, ...this.conversationsIn(folder)]))
    this.emit(id);
}
