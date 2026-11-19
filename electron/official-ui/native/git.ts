import { z } from "zod";
import { watch, type FSWatcher } from "node:fs";
import type { SessionWorktreeProbe } from "../../git/code-worktree";
import type { NativeHost } from "./host";
import type {
  OfficialGitRequest,
  OfficialGitRow,
} from "../../git/official-git";
import { sessionAccountScope } from "./session-account-scope";
import { isLocalCodeSession } from "../api/code-session-ownership";
import { localWorkingTree } from "../../git/working-tree";
import { runGh } from "../../git/github-cli";

type GitIndexWatch = {
  sessions: Set<string>;
  watcher: FSWatcher;
  pending?: ReturnType<typeof setTimeout>;
};

export function registerGit(host: NativeHost) {
  const { ctx } = host;
  const rows = new Map<string, OfficialGitRow | null>();
  const watches = new Map<string, GitIndexWatch>();
  const closeWatch = (directory: string) => {
    const entry = watches.get(directory);
    if (!entry) return;
    clearTimeout(entry.pending);
    entry.watcher.close();
    watches.delete(directory);
  };
  let disposed = false,
    polling = false;
  let cursor = 0;
  const scope = sessionAccountScope(ctx, () => {
    const removed = [...rows.keys()];
    rows.clear();
    for (const directory of watches.keys()) closeWatch(directory);
    cursor = 0;
    if (removed.length) host.emit("GitState", "gitStateChanged", [], removed);
  });
  const read = (input: OfficialGitRequest, target?: { sshConfig: unknown } | { wsl: unknown }) =>
    scope.guard(async () => {
      if (!ctx.account() || !ctx.localCall)
        throw Error("Local Git requires a signed-in desktop account.");
      return ctx.localCall("officialGitRead", input, target);
    });
  const on = (name: string, fn: (...args: any[]) => unknown) =>
    host.on(name, (...args) => scope.run(() => fn(...args)));
  const watchIndex = (directory: string, id: string) => {
    const existing = watches.get(directory);
    if (existing) {
      existing.sessions.add(id);
      return;
    }
    if (watches.size >= 500) return;
    try {
      const watcher = watch(directory, { persistent: false }, (_event, file) => {
        if (file !== null && file !== "index") return;
        clearTimeout(entry.pending);
        entry.pending = setTimeout(() => {
          try { scope.sync(); } catch { return; }
          if (watches.get(directory) !== entry) return;
          for (const sessionId of entry.sessions)
            host.emit("LocalSessions", "onEvent", { type: "git_state_changed", sessionId });
        }, 150);
      });
      const entry: GitIndexWatch = { sessions: new Set([id]), watcher };
      watcher.on("error", () => {
        if (watches.get(directory) === entry) closeWatch(directory);
      });
      watches.set(directory, entry);
    } catch {
      // Focus and explicit refresh still query Git when the OS cannot watch this directory.
    }
  };
  const refresh = async (cwd: string) => {
    const next = (await read({ kind: "state", cwd })) as OfficialGitRow | null;
    if (disposed) return next;
    const before = rows.get(cwd);
    if (!rows.has(cwd) && rows.size >= 500)
      throw Error("Too many Git subscriptions.");
    rows.set(cwd, next);
    if (JSON.stringify(before) !== JSON.stringify(next))
      host.emit(
        "GitState",
        "gitStateChanged",
        next ? [next] : [],
        next ? [] : [cwd],
      );
    return next;
  };
  on("GitState.getGitStateSnapshot", async (raw: unknown) => {
    const cwds = z.array(z.string().min(1).max(1024)).max(500).parse(raw);
    const result: OfficialGitRow[] = [];
    for (const cwd of new Set(cwds)) {
      // An unauthorized cwd is rejected, rather than being subscribed by a fabricated renderer path.
      const row = await refresh(cwd);
      if (row) result.push(row);
    }
    return result;
  });
  on("LocalSessions.getGitInfo", (cwd: string) => read({ kind: "info", cwd }));
  on("LocalSessions.checkGhAvailable", async (raw: unknown) => {
    const cwd = z.string().min(1).max(4096).parse(raw);
    await read({ kind: "info", cwd });
    const result = await scope.guard(() => runGh(["api", "--hostname", "github.com", "user"]));
    return result.code === 0 || /HTTP (?:403|429|5\d\d)\b/.test(result.stderr);
  });
  on("ClaudeCode.checkGitAvailable", async () => {
    try {
      await localWorkingTree.git(process.cwd(), ["--version"]);
      return { available: true, switchesBranchInFolder: true };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      return { available: false, reason: code === "ENOENT" ? "not-found" :
        code === "EACCES" || code === "EPERM" ? "exec-blocked" : "startup-failed" };
    }
  });
  const branch = (input: unknown) => scope.guard(async () => {
    if (!ctx.account() || !ctx.localCall)
      throw Error("Local Git requires a signed-in desktop account.");
    return ctx.localCall("officialGitBranch", input);
  });
  on("LocalSessions.checkBranchSwitchConflict", (cwd: unknown, target: unknown) =>
    branch({ kind: "conflict", cwd, branch: target }));
  on("LocalSessions.isBranchOnOrigin", (cwd: unknown, target: unknown) =>
    branch({ kind: "origin", cwd, branch: target }));
  on("LocalSessions.stashWorkingTree", (cwd: unknown, message: unknown) =>
    branch({ kind: "stash", cwd, message }));
  on("LocalSessions.commitWipForBranchSwitch", (cwd: unknown, fromBranch: unknown) =>
    branch({ kind: "commit", cwd, fromBranch }));
  on("LocalSessions.discardWorkingTree", (cwd: unknown) =>
    branch({ kind: "discard", cwd }));
  const workingTreeDirtyState = async (cwd: string) => {
    const changes = (await read({ kind: "changes", cwd })) as string[] | null;
    return changes === null ? "unknown" : changes.length ? "dirty" : "clean";
  };
  on("LocalSessions.getWorkingTreeDirtyState", workingTreeDirtyState);
  on("LocalSessions.getWorkingTreeStatus", (cwd: string) => read({ kind: "workingTreeStatus", cwd }));
  on(
    "LocalSessions.isWorkingTreeDirty",
    async (cwd: string) => (await workingTreeDirtyState(cwd)) !== "clean",
  );
  on(
    "LocalSessions.getLocalBranches",
    async (cwd: string) => (await read({ kind: "branches", cwd })) ?? [],
  );
  on(
    "LocalSessions.getGitDiff",
    (
      cwd: string,
      base: string,
      head?: string,
      options?: {
        includePatches?: boolean;
        inlinePatchesMaxChangedLines?: number;
      },
    ) =>
      read({
        kind: "diff",
        cwd,
        base,
        head,
        includePatches: options?.includePatches,
        inlinePatchesMaxChangedLines: options?.inlinePatchesMaxChangedLines,
      }),
  );
  on(
    "LocalSessions.getGitDiffStats",
    (cwd: string, base: string, head?: string) =>
      read({ kind: "stats", cwd, base, head }),
  );
  on(
    "LocalSessions.getGitCommits",
    (cwd: string, base: string, head?: string) =>
      read({ kind: "commits", cwd, base, head }),
  );
  on("LocalSessions.getCommitDiff", (cwd: string, sha: string) =>
    read({ kind: "commit", cwd, sha }),
  );
  on(
    "LocalSessions.getDiffFileContent",
    (cwd: string, base: string, file: string, previous?: string) =>
      read({ kind: "content", cwd, base, file, previous }),
  );
  on("LocalSessions.getDiffFileImage", (raw: unknown) => {
    const { cwd, rev, filePath } = z
      .object({
        cwd: z.string(),
        rev: z.string().optional(),
        filePath: z.string(),
      })
      .parse(raw);
    return read({ kind: "image", cwd, rev, file: filePath });
  });
  on(
    "LocalSessions.getGitDiffFilePatch",
    (cwd: string, base: string, file: string, previous?: string) =>
      read({ kind: "patch", cwd, base, file, previous }),
  );
  for (const prefix of ["SSH", "Remote"] as const) {
    const remote = (target: unknown, input: OfficialGitRequest) =>
      read(input, prefix === "SSH" ? { sshConfig: target } : { wsl: target });
    on(`LocalSessions.get${prefix}GitInfo`, (target: unknown, cwd: string) =>
      remote(target, { kind: "info", cwd }));
    on(`LocalSessions.get${prefix}LocalBranches`, async (target: unknown, cwd: string) =>
      (await remote(target, { kind: "branches", cwd })) ?? []);
    on(`LocalSessions.get${prefix}GitDiff`, (target: unknown, cwd: string, base: string, head?: string) =>
      remote(target, { kind: "diff", cwd, base, head }));
    on(`LocalSessions.get${prefix}GitDiffStats`, (target: unknown, cwd: string, base: string, head?: string) =>
      remote(target, { kind: "stats", cwd, base, head }));
    on(`LocalSessions.get${prefix}GitCommits`, (target: unknown, cwd: string, base: string, head?: string) =>
      remote(target, { kind: "commits", cwd, base, head }));
    on(`LocalSessions.get${prefix}CommitDiff`, (target: unknown, cwd: string, sha: string) =>
      remote(target, { kind: "commit", cwd, sha }));
    on(`LocalSessions.get${prefix}DiffFileContent`,
      (target: unknown, cwd: string, base: string, file: string, previous?: string) =>
        remote(target, { kind: "content", cwd, base, file, previous }));
  }
  const sessionId = z.string().min(7).max(506).startsWith("local_");
  const session = async (raw: unknown) => {
    const id = sessionId.parse(raw).slice(6);
    const c = await scope.guard(() => ctx.localLoadConversation!(id));
    if (
      !c ||
      c.mode !== "code" ||
      c.cloudHosted ||
      c.cloudEnvironmentId ||
      (c.environment?.kind === "ssh" && !ctx.sshCodeEnvironment?.(c)) ||
      !c.cwd
    )
      throw Error("Open a local Code session to read its Git changes.");
    return c;
  };
  const worktree = (raw: unknown, kind: "probe" | "probeByFolder") => scope.guard(async () => {
    if (!ctx.account() || !ctx.localCall)
      throw Error("Local Git requires a signed-in desktop account.");
    return await ctx.localCall("officialCodeWorktreeLifecycle", {
      kind,
      sessionId: sessionId.parse(raw).slice(6),
    });
  });
  on("LocalSessions.getUncommittedChanges", async (id: unknown) =>
    (await worktree(id, "probe") as SessionWorktreeProbe | null)?.changes ?? null);
  on("LocalSessions.getUncommittedChangesByFolder", (id: unknown) =>
    worktree(id, "probeByFolder"));
  for (const op of ["refreshGitState", "invalidateGitDiffCache"])
    on(`LocalSessions.${op}`, async (id: string) => {
      const c = await session(id);
      if (c.environment?.kind === "ssh" || c.environment?.kind === "wsl") return;
      await refresh(c.cwd!);
      const folders = new Set([c.cwd!, ...(c.additionalFolders ?? [])]);
      await Promise.all([...folders].filter(folder => folder !== c.cwd)
        .map(folder => refresh(folder).catch(() => undefined)));
      const directories = await Promise.all([...folders].map(cwd =>
        scope.guard(() => ctx.localCall!("officialGitDirectory", cwd)).catch(() => null),
      ));
      scope.sync();
      for (const [directory, entry] of watches) {
        if (!directories.includes(directory) && entry.sessions.delete(id) && !entry.sessions.size)
          closeWatch(directory);
      }
      if (!disposed)
        for (const directory of new Set(directories))
          if (typeof directory === "string" && directory) watchIndex(directory, id);
    });
  const timer = setInterval(() => {
    if (polling || disposed) return;
    polling = true;
    void scope
      .run(async () => {
        const keys = [...rows.keys()];
        const batch = Array.from(
          { length: Math.min(8, keys.length) },
          (_, i) => keys[(cursor + i) % keys.length],
        );
        cursor = keys.length ? (cursor + batch.length) % keys.length : 0;
        for (const cwd of batch) {
          if (disposed) break;
          try {
            await refresh(cwd);
          } catch {
            // A retired poll must not remove a new account's subscription to the same path.
            try {
              scope.sync();
            } catch {
              break;
            }
            if (rows.delete(cwd))
              host.emit("GitState", "gitStateChanged", [], [cwd]);
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        polling = false;
      });
  }, 2000);
  timer.unref();
  const off = ctx.onEvent((event) => {
    scope.sync();
    if (event.type !== "terminal-busy" || event.busy || !ctx.localListConversations)
      return;
    void scope.guard(() => ctx.localListConversations!()).then((conversations) => {
      const local = conversations.filter((conversation) => !conversation.archived && isLocalCodeSession(conversation));
      const owner = local.find((conversation) => conversation.id === event.conversationId);
      if (!owner) return;
      const folders = new Set([owner.cwd, ...(owner.additionalFolders ?? [])]);
      for (const conversation of local) {
        const own = conversation === owner;
        if (!own && ![conversation.cwd, ...(conversation.additionalFolders ?? [])].some((folder) => folders.has(folder)))
          continue;
        host.emit("LocalSessions", "onEvent", {
          type: "working_tree_changed",
          sessionId: `local_${conversation.id}`,
          workingTreeChangeCause: own ? "terminal_command" : "other_session",
        });
      }
    }).catch(() => {});
  });
  return () => {
    disposed = true;
    clearInterval(timer);
    rows.clear();
    for (const directory of watches.keys()) closeWatch(directory);
    off();
  };
}
