/** Account-scoped Resources reads. Focus is navigation state, never a folder grant. */
import { readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { MentionFile } from "../../../shared/composer-api";
import { mentionSkippedFolders } from "../../engine/composer-files";
import { sameEnvironment } from "../../engine/engine-types";
import {
  projectSearchMaxResults,
  type ProjectSearchOptions,
  type ProjectSearchResult,
} from "../../../shared/project-files";
import type { NativeHost } from "./host";
import { sessionAccountScope } from "./session-account-scope";
import { readNativeSshCommands } from "./slash-commands";
import { listWslDistros, wslWorkspace } from "../../wsl/wsl";
import type { DirectoryListing } from "../../ssh/remote-scripts";
import type { SshHost, SshStatus } from "../../../shared/ssh-api";
import type { WorkspaceTrust } from "../../../shared/workspace-trust-api";
import type { Conversation, EnvironmentRef } from "../../../shared/types";
import { wslEnvironmentInput } from "../../workspace/workspace-fs";
import { checkHostPath } from "../../ssh/remote-workspace";
import { localCodeDirectory, remoteCodeDirectory, resolveLocalCodeDirectory } from "../../workspace/code-additional-folder";

type RemoteEnvironment = Extract<EnvironmentRef, { kind: "ssh" | "wsl" }>;
type Focus = { folder: string; environment?: RemoteEnvironment };

const sshConnected = ({ state }: SshStatus) =>
  state === "ready" || state === "installing" || state === "starting";

const relativePath = (value: unknown): value is string => typeof value === "string" &&
  value.length > 0 && value.length <= 4096 && !/[\0\r\n]/.test(value) &&
  !path.isAbsolute(value) && !/^[A-Za-z]:/.test(value) &&
  !value.split(/[\\/]/).some((part) => part === ".." || part === "." || !part);
const text = (value: unknown, max: number) => {
  if (typeof value !== "string" || value.length > max || value.includes("\0"))
    throw Error("Invalid file search query.");
  return value;
};

export function registerResources(host: NativeHost) {
  const { ctx } = host;
  let draft: Focus | undefined;
  let sessionId: string | undefined;
  let revision = 0;
  let listingVersion = 0;
  let lastListing: { paths: string; version: string } | undefined;
  const files = new Map<string, string>();
  const changed = () => { files.clear(); lastListing = undefined; revision++; };
  const reset = () => { draft = undefined; sessionId = undefined; changed(); };
  const scope = sessionAccountScope(ctx, reset);
  const current = () => {
    if (ctx.readOnly || !scope.sync().owner || ctx.isCurrent?.() === false)
      throw Error("The file resource account is no longer active.");
  };
  const on = (name: string, fn: (...args: any[]) => unknown) =>
    host.on(name, (...args) => scope.run(async () => { current(); return fn(...args); }));
  const resolveSsh = (target: unknown) => scope.guard(() =>
    ctx.localCall!("officialSshTarget", target)) as Promise<{ kind: "ssh"; hostId: string }>;
  const sshState = (hostId: string, connect = false) => scope.guard(() =>
    ctx.localCall!(connect ? "sshConnect" : "sshStatus", hostId)) as Promise<SshStatus>;
  const snapshot = () => {
    current();
    const version = revision;
    const check = () => {
      current();
      if (revision !== version) throw Error("The focused folder changed during this read. Retry.");
    };
    return { draft, sessionId, check };
  };
  const read = async <T>(check: () => void, fn: () => Promise<T>) => {
    check();
    const result = await scope.guard(fn);
    check();
    return result;
  };
  const owned = (c: Conversation, id: string) => c.id === id &&
    c.mode === "code" && !c.cloudHosted && !c.cloudEnvironmentId &&
    (!c.sessionAuthors || (c.sessionAuthors.ownerAccountUuid === ctx.account()?.id &&
      c.sessionAuthors.viewerAccountUuid === ctx.account()?.id));
  const focused = async (s: ReturnType<typeof snapshot>): Promise<Focus | undefined> => {
    const id = s.sessionId;
    if (!id) return s.draft;
    if (!ctx.localLoadConversation) return;
    const c = await read(s.check, () => ctx.localLoadConversation!(id));
    if (!c || !owned(c, id) || c.environment?.kind === "space") return;
    const folder = c.worktree?.state === "deleted" ? c.worktree.origin : c.cwd;
    if (!folder) return;
    const environment = c.environment?.kind === "local" ? undefined : c.environment;
    return { folder, environment };
  };
  const localTarget = async (s: ReturnType<typeof snapshot>, folder: string) => {
    if (s.sessionId) return s.sessionId;
    if (!ctx.localListConversations || !ctx.localLoadConversation || !ctx.localCall)
      throw Error("Local project file reads are unavailable.");
    const rows = await read(s.check, () => ctx.localListConversations!());
    const candidate = rows.find(c => c.cwd === folder && (c.environment?.kind ?? "local") === "local" && owned(c, c.id));
    if (!candidate) return { cwd: folder };
    const c = await read(s.check, () => ctx.localLoadConversation!(candidate.id));
    if (!c || !owned(c, candidate.id) || c.cwd !== folder || (c.environment?.kind ?? "local") !== "local")
      throw Error("The project no longer belongs to this local session.");
    return c.id;
  };
  const versioned = (paths: string) => {
    if (lastListing?.paths !== paths)
      lastListing = { paths, version: String(++listingVersion) };
    return lastListing;
  };
  const listing = async () => {
    const s = snapshot();
    const focus = await focused(s);
    if (!focus) return null;
    const { folder, environment } = focus;
    if (environment) {
      const entries = await read(s.check, () => ctx.localCall!("officialSessionFile", {
        operation: "index", cwd: folder, environment, path: "",
      })) as MentionFile[];
      return versioned(entries.filter(entry => relativePath(entry.path))
        .map(entry => entry.path + (entry.kind === "folder" ? "/" : "")).sort().join("\n"));
    }
    const target = await localTarget(s, folder);
    const queue = [""]; const found: string[] = []; const seen = new Set<string>();
    let bytes = 0;
    for (let i = 0; i < queue.length; i++) {
      if (i >= 2000) throw Error("Project index exceeds the folder limit; no partial index was returned.");
      const parent = queue[i];
      const result = await read(s.check, () => ctx.localCall!("listProjectFolder", target, parent)) as any;
      if (!result || !Array.isArray(result.entries) || typeof result.truncated !== "boolean")
        throw Error("Invalid project folder response.");
      if (result.truncated) throw Error("Project folder listing is truncated; no partial index was returned.");
      for (const entry of result.entries) {
        if (!relativePath(entry?.path) || !["file", "folder"].includes(entry.kind) ||
          entry.path.includes("\\") || path.posix.dirname(entry.path) !== (parent || ".") || seen.has(entry.path))
          throw Error("Invalid project entry path.");
        if (entry.kind === "folder" && mentionSkippedFolders.includes(path.posix.basename(entry.path)))
          continue;
        seen.add(entry.path);
        if (seen.size > 20000 || entry.path.split("/").length > 32)
          throw Error("Project index exceeds its safe limit; no partial index was returned.");
        bytes += Buffer.byteLength(entry.path) + 2;
        if (bytes > 4 * 1024 * 1024) throw Error("Project index is too large.");
        found.push(entry.path + (entry.kind === "folder" ? "/" : ""));
        if (entry.kind === "folder" && !entry.symlink) queue.push(entry.path);
      }
    }
    found.sort();
    const paths = found.join("\n");
    if (Buffer.byteLength(paths) > 4 * 1024 * 1024) throw Error("Project index is too large.");
    s.check();
    return versioned(paths);
  };
  on("FileSystem.browseFolder", async (title?: string, _restrictToHomeDir?: boolean, _coworkMount?: boolean, wslDistro?: string) => {
    const caller = host.caller;
    const folder = await scope.guard(() => ctx.localCall!("chooseFolder", title, wslDistro ?? undefined));
    if (typeof folder === "string" && !wslDistro) host.recordFolderSelection(caller, [folder]);
    return folder;
  });
  on("FileSystem.getSystemPath", async () => {
    const s = snapshot();
    const environment = (await focused(s))?.environment;
    if (environment?.kind === "wsl")
      return read(s.check, () => wslWorkspace(environment.distro).homeDirectory());
    return os.homedir();
  });
  on("FileSystem.browseFile", async (title: unknown, rawFolder?: unknown) => {
    const caller = host.caller;
    if (!caller) throw Error("Choose a file in this account window.");
    const { dialog } = await import("electron");
    const folder = rawFolder === undefined
      ? undefined
      : resolveLocalCodeDirectory(localCodeDirectory.parse(rawFolder));
    const result = await scope.guard(() => dialog.showOpenDialog(caller, {
      title: text(title, 200),
      properties: ["openFile"],
      ...(folder && { defaultPath: folder }),
    }));
    if (result.canceled || result.filePaths.length !== 1) return null;
    const file = await scope.guard(() => realpath(result.filePaths[0]));
    if (!localCodeDirectory.safeParse(file).success ||
        !(await scope.guard(() => stat(file))).isFile()) return null;
    const parent = path.dirname(file);
    const relative = folder && path.relative(folder, file);
    const relPath = relative && relative !== ".." &&
      !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
      ? relative : undefined;
    current();
    host.recordFolderSelection(caller, [parent]);
    return { folder: parent, name: path.basename(file), ...(relPath && { relPath }) };
  });
  on("FileSystem.listDirectory", async (raw: unknown) => {
    const unavailable = { directories: [], error: "Couldn't open that folder. Check the path and try again." };
    const s = snapshot();
    try {
      const focus = await focused(s);
      if (focus?.environment?.kind === "wsl") {
        const folder = remoteCodeDirectory.parse(raw);
        const workspace = wslWorkspace(focus.environment.distro);
        const listing = await read(s.check, () => workspace.listDirectory(folder));
        return {
          resolvedPath: listing.path,
          directories: listing.entries.filter(entry => entry.kind === "folder").map(entry => entry.name),
        };
      }
      if (focus?.environment) return unavailable;
      const folder = localCodeDirectory.parse(raw);
      const resolvedPath = resolveLocalCodeDirectory(folder);
      const entries = await read(s.check, () => readdir(resolvedPath, { withFileTypes: true }));
      return {
        resolvedPath,
        directories: entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort(),
      };
    } catch {
      current();
      return unavailable;
    }
  });
  on("LocalSessions.listWslDistros", () => scope.guard(listWslDistros));
  on("LocalSessions.canStartWslSession", async (distro: unknown) =>
    typeof distro === "string" && (await scope.guard(listWslDistros)).some(
      ({ name, version }) => version === 2 && name.toLowerCase() === distro.toLowerCase(),
    ));
  on("LocalSessions.checkRemoteTargetTrust", (target: unknown, cwd: unknown) =>
    scope.guard(() => ctx.localCall!("officialWslTrust", target, cwd)));
  on("LocalSessions.saveRemoteTargetTrust", async (target: unknown, cwd: unknown) => {
    if (target && typeof target === "object" && "kind" in target && target.kind === "ssh") {
      const place = await resolveSsh(target);
      const state = await sshState(place.hostId, true);
      if (!sshConnected(state)) throw Error("Connect to the SSH host before trusting the folder.");
      await scope.guard(() => ctx.localCall!("sshChooseFolder", place.hostId, cwd));
      await scope.guard(() => ctx.localCall!("saveWorkspaceTrust", cwd, place));
      return;
    }
    await scope.guard(() => ctx.localCall!("officialWslTrust", target, cwd, true));
  });
  on("LocalSessions.getSSHConfigs", async () => {
    const { hosts } = await scope.guard(() => ctx.localCall!("sshListHosts")) as { hosts: SshHost[] };
    return hosts.map(host => ({
      id: host.id, name: host.label, sshHost: host.destination,
      sshPort: host.port, sshIdentityFile: host.identityFile, remoteCwd: host.defaultFolder,
      source: "desktop",
    }));
  });
  on("LocalSessions.getSSHDraftCommandNames", async (hostId: unknown, cwd?: unknown) => {
    if (typeof hostId !== "string") return null;
    const list = await readNativeSshCommands((name, ...args) =>
      scope.guard(() => ctx.localCall!(name, ...args)),
    { kind: "draft", hostId, cwd: typeof cwd === "string" ? cwd : undefined });
    return list?.commands.map(({ name, description }) => ({ name, description })) ?? null;
  });
  on("LocalSessions.setSSHConfigs", (configs: unknown) =>
    scope.guard(() => ctx.localCall!("officialSetSshConfigs", configs)));
  const testSSHConnection = async (target: unknown, interactive: boolean) => {
    try {
      const draft = z.object({
        id: z.string().optional(),
        sshHost: z.string(),
        sshPort: z.number().optional(),
        sshIdentityFile: z.string().optional(),
      }).parse(target);
      const result = z.object({
        ok: z.boolean(),
        code: z.string().optional(),
        error: z.string().optional(),
        details: z.string().optional(),
      }).parse(await scope.guard(() => ctx.localCall!("sshTestHost", {
        id: draft.id,
        destination: draft.sshHost,
        port: draft.sshPort,
        identityFile: draft.sshIdentityFile,
      }, interactive)));
      return result.ok ? { valid: true } : {
        valid: false,
        error: result.error ?? "SSH host is not connected.",
        ...(!interactive && result.code === "auth-failed" ? {
          failureReason: /Host key verification failed/i.test(result.details ?? "")
            ? "hostkey_confirm_needed" : "auth_sign_in_needed",
        } : {}),
        ...(result.details ? { diagnostic: result.details } : {}),
      };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  on("LocalSessions.testSSHConnection", (target: unknown) => testSSHConnection(target, true));
  on("LocalSessions.probeSSHConnection", (target: unknown) => testSSHConnection(target, false));
  on("LocalSessions.listSSHDirectory", async (target: unknown, folder?: string, options?: { automatic?: boolean }) => {
    try {
      const { hostId } = await resolveSsh(target);
      const state = await sshState(hostId, options?.automatic !== true);
      if (!sshConnected(state)) return { entries: [], error: "SSH host is not connected.", notConnected: true };
      const listing = await scope.guard(() => ctx.localCall!("sshListDirectory", hostId, folder)) as DirectoryListing;
      return {
        resolvedPath: listing.path,
        entries: listing.entries.map(entry => ({
          name: entry.name, path: path.posix.join(listing.path, entry.name), isDirectory: entry.kind === "folder",
        })),
      };
    } catch (error) {
      return { entries: [], error: error instanceof Error ? error.message : String(error) };
    }
  });
  on("LocalSessions.checkRemoteTrust", async (target: unknown, folder: string) => {
    const place = await resolveSsh(target);
    const trust = await scope.guard(() => ctx.localCall!("checkWorkspaceTrust", folder, place, false)) as WorkspaceTrust;
    if (trust.trusted && folder)
      await scope.guard(() => ctx.localCall!("sshChooseFolder", place.hostId, folder));
    return trust;
  });
  on("LocalSessions.resolveSSHSettings", async (target: unknown, folder?: unknown, options?: unknown) => {
    const { hostId } = await resolveSsh(target);
    return scope.guard(() => ctx.localCall!("officialResolveSshSettings", hostId, folder, options));
  });
  on("FileSystem.browseFolders", async (title?: string) => {
    const caller = host.caller;
    const folders = await scope.guard(() => ctx.localCall!("chooseFolders", title));
    if (Array.isArray(folders) && folders.every(folder => typeof folder === "string"))
      host.recordFolderSelection(caller, folders);
    return folders;
  });
  const setDraft = (focus: Focus | undefined) => {
    if (draft?.folder === focus?.folder &&
      sameEnvironment(draft?.environment, focus?.environment)) return;
    draft = focus;
    changed();
  };
  on("Resources.setFocusedCwd", (folder: unknown) => {
    if (folder !== null && (typeof folder !== "string" || !path.isAbsolute(folder) || folder.length > 4096 || /[\0\r\n]/.test(folder)))
      throw Error("Invalid focused folder.");
    setDraft(folder ? { folder } : undefined);
  });
  on("Resources.setFocusedSshTarget", (folder: unknown, hostId: unknown) => {
    setDraft(folder === null || hostId === null ? undefined : {
      folder: checkHostPath(folder),
      environment: { kind: "ssh", hostId: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/).parse(hostId) },
    });
  });
  on("Resources.setFocusedRemoteTarget", (folder: unknown, target: unknown) => {
    setDraft(folder === null || target === null ? undefined : {
      folder: checkHostPath(folder), environment: wslEnvironmentInput.parse(target),
    });
  });
  on("LocalSessions.listRemoteDirectory", async (target: unknown, folder: unknown, directory: unknown) => {
    try {
      const environment = wslEnvironmentInput.parse(target);
      const answer = await scope.guard(() => ctx.localCall!("officialSessionFile", {
        operation: "list", cwd: folder, path: directory, environment,
      })) as { status: string; entries?: unknown[]; resolvedPath?: string };
      if (answer.status !== "ok") return { entries: [], error: answer.status };
      return { entries: answer.entries, resolvedPath: answer.resolvedPath };
    } catch (error) {
      return { entries: [], error: error instanceof Error ? error.message : String(error) };
    }
  });
  on("Resources.fetchMentionOptions", async (query: unknown, filter?: string) => {
    const q = text(query, 300); const s = snapshot();
    if (filter && filter !== "files") throw Error("This mention resource category is unavailable.");
    const focus = await focused(s);
    if (!focus) return [];
    const { folder, environment } = focus;
    const result = await read(s.check, () => environment
      ? ctx.localCall!("officialSessionFile", { operation: "mention", cwd: folder, environment, path: q })
      : ctx.call("mentionFiles", { folder }, q)) as MentionFile[];
    if (!Array.isArray(result) || result.length > 50 || result.some(f => !relativePath(f?.path) || !["file", "folder"].includes(f.kind)))
      throw Error("Invalid mention file response.");
    return result.map(file => {
      const paths = environment ? path.posix : path;
      const id = `file-${paths.join(folder, file.path)}`;
      if (files.size >= 2000) files.clear();
      files.set(id, paths.basename(file.path));
      return { id, label: file.path, icon: file.kind === "folder" ? "directory" : "file", category: "Files",
        metadata: JSON.stringify({ path: file.path, isDirectory: file.kind === "folder" }) };
    });
  });
  on("Resources.handleMentionSelect", (id: string) => {
    const known = files.get(id);
    if (!known) throw Error("This file suggestion expired. Search again.");
    return { chipText: known };
  });
  on("Resources.getProjectFileList", async () => (await listing())?.paths ?? null);
  on("Resources.getProjectFileListIfChanged", async (known?: string) => {
    if (known !== undefined) text(known, 4096);
    const result = await listing();
    return result && known !== undefined && result.version === known
      ? { version: result.version, paths: null }
      : result;
  });
  const search = async (
    query: unknown,
    maxResults: number,
    options?: Pick<ProjectSearchOptions, "matchCase" | "wholeWord" | "regexp">,
  ) => {
    const q = text(query, 1000);
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > projectSearchMaxResults)
      throw Error("Invalid content search result limit.");
    const s = snapshot();
    const focus = await focused(s);
    if (!focus || focus.environment?.kind === "ssh") return { matches: [], patternRefused: false };
    const { folder, environment } = focus;
    const target = environment ? { cwd: folder, environment } : await localTarget(s, folder);
    const result = await read(s.check, () => ctx.localCall!("searchProjectFiles", target, q, {
      ...options, strict: true, maxResults, filesPane: true,
    })) as ProjectSearchResult;
    if (!result || !Array.isArray(result.matches) || result.matches.length > maxResults || typeof result.truncated !== "boolean")
      throw Error("Invalid content search response.");
    if (result.truncated && result.matches.length < maxResults)
      throw Error("Content search was truncated. Narrow the query and retry.");
    const matches = result.matches.map((m) => {
      if (!relativePath(m?.path) || !Number.isInteger(m.line) || m.line < 1 || typeof m.preview !== "string" ||
          m.preview.length > 1000 || m.column === undefined || !Number.isInteger(m.column) || m.column < 1)
        throw Error("Invalid content search match.");
      return { relativePath: m.path, absPath: (environment ? path.posix : path).join(folder, m.path), line: m.line,
        column: m.column, preview: m.preview, ...(m.previewMatches ? { previewMatches: m.previewMatches } : {}) };
    });
    return { matches, patternRefused: result.patternRefused === true };
  };
  on("Resources.searchFileContents", async (query: unknown, maxResults = 200) =>
    (await search(query, maxResults)).matches,
  );
  on("Resources.searchFileContentsWithOptions", (raw: unknown) => {
    const input = z.object({
      query: z.string().max(1000),
      maxResults: z.number().int().min(1).max(projectSearchMaxResults).default(200),
      options: z.object({
        matchCase: z.boolean().optional(),
        wholeWord: z.boolean().optional(),
        regexp: z.boolean().optional(),
      }).strict().optional(),
    }).strict().parse(raw);
    return search(input.query, input.maxResults, input.options);
  });
  return (id?: string | null) => {
    scope.sync();
    const next = typeof id === "string" && id.startsWith("local_") ? id.slice(6) : undefined;
    if (sessionId === next) return;
    sessionId = next;
    changed();
  };
}
