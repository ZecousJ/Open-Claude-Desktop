import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  officialGitRequest,
  readOfficialGit,
} from "../electron/git/official-git";
import { registerOfficialGitHandlers } from "../electron/ipc/official-git";
import { registerGit } from "../electron/official-ui/native/git";

async function fixture(
  t: { after(fn: () => any): void },
  objectFormat?: "sha256",
) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "claudex-official-git-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(
    "init",
    "-b",
    "main",
    ...(objectFormat ? [`--object-format=${objectFormat}`] : []),
  );
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  const write = (name: string, content: string) =>
    fs.writeFile(path.join(cwd, name), content);
  const read = async (kind: string, extra: Record<string, unknown> = {}) =>
    readOfficialGit(
      officialGitRequest.parse({ kind, cwd, ...extra }),
    ) as Promise<any>;
  return { cwd, git, write, read };
}

test("real Git: unborn, committed, rename, unicode/newline names, binary, deletion, lazy patch and content", async (t) => {
  const f = await fixture(t);
  await f.write("first.txt", "before\n");
  assert.equal((await f.read("state")).branch, "main");
  assert.deepEqual(await f.read("changes"), ["first.txt"]);
  assert.equal((await f.read("diff", { base: "HEAD" })).files[0].additions, 1);
  f.git("add", ".");
  f.git("commit", "-m", "initial");
  f.git("checkout", "-b", "feature");
  f.git("mv", "first.txt", "renamed.txt");
  await f.write("renamed.txt", "before\nafter\n");
  const odd = "中文\twith\nnewline.txt";
  await f.write(odd, "one\ntwo\n");
  await fs.writeFile(path.join(f.cwd, "binary.bin"), Buffer.from([0, 1, 2]));
  const changes = await f.read("changes");
  assert.ok(changes.includes(odd));
  assert.ok(changes.includes("renamed.txt"));
  const workingTree = await f.read("workingTreeStatus");
  assert.ok(workingTree.files.some((row: { path: string; status: string }) =>
    row.path === "first.txt -> renamed.txt" && row.status.startsWith("R")));
  assert.deepEqual([workingTree.additions, workingTree.deletions], [1, 0]);
  const diff = await f.read("diff", { base: "main", includePatches: false });
  const rename = diff.files.find((x: any) => x.filename === "renamed.txt");
  assert.equal(rename.status, "renamed");
  assert.equal(rename.previous_filename, "first.txt");
  assert.equal(rename.additions, 1);
  assert.equal(rename.patch, undefined);
  const inline = await f.read("diff", {
    base: "main",
    includePatches: false,
    inlinePatchesMaxChangedLines: 20_000,
  });
  assert.match(
    inline.files.find((x: any) => x.filename === "renamed.txt").patch,
    /\+after/,
  );
  assert.equal(inline.patches_withheld, false);
  assert.match(
    inline.files.find((x: any) => x.filename === "binary.bin").patch,
    /^Binary files /m,
  );
  const limited = await f.read("diff", {
    base: "main",
    includePatches: false,
    inlinePatchesMaxChangedLines: 1,
  });
  assert.ok(limited.files.every((x: any) => x.patch === undefined));
  assert.equal(limited.patches_withheld, true);
  assert.equal(diff.files.find((x: any) => x.filename === odd).additions, 2);
  assert.equal(
    diff.files.find((x: any) => x.filename === "binary.bin").changes,
    0,
  );
  assert.deepEqual(
    await f.read("content", {
      base: diff.merge_base,
      file: "renamed.txt",
      previous: "first.txt",
    }),
    { oldText: "before\n", newText: "before\nafter\n" },
  );
  assert.match(
    await f.read("patch", { base: diff.merge_base, file: odd }),
    /\+two/,
  );
  assert.equal((await f.read("stats", { base: "main" })).fileCount, 3);
  f.git("add", ".");
  f.git("commit", "-m", "feature change");
  const sha = f.git("rev-parse", "HEAD");
  const commits = await f.read("commits", { base: "main" });
  assert.equal(commits.length, 1);
  assert.equal(commits[0].sha, sha);
  assert.equal(commits[0].subject, "feature change");
  // The official commit row multiplies seconds by 1000 for its date formatter.
  assert.ok(commits[0].date > 1e9 && commits[0].date < 1e11);
  assert.equal((await f.read("commit", { sha })).files.length, 3);
  await fs.rm(path.join(f.cwd, "renamed.txt"));
  assert.equal(
    (await f.read("diff", { base: "HEAD" })).files[0].status,
    "removed",
  );
  assert.equal(
    (await f.read("content", { base: "HEAD", file: "renamed.txt" })).newText,
    null,
  );
  const fallback = await f.read("diff", { base: "missing-branch" });
  assert.equal(fallback.base_ref, "HEAD");
  assert.equal(fallback.merge_base, sha);
  assert.equal(fallback.files[0].status, "removed");
  assert.equal(
    await f.read("diff", { base: "missing-branch", head: "feature" }),
    null,
  );
});

test("real Git bounds inline and individual patches while preserving file metadata", async (t) => {
  const f = await fixture(t);
  await f.write("big.txt", "a".repeat(3 * 1024 * 1024) + "\n");
  await f.write("script.sh", "echo hello\n");
  f.git("add", ".");
  f.git("commit", "-m", "base");
  await f.write("big.txt", "b".repeat(3 * 1024 * 1024) + "\n");
  if (process.platform !== "win32")
    await fs.chmod(path.join(f.cwd, "script.sh"), 0o755);
  const options = {
    base: "HEAD",
    includePatches: false,
    inlinePatchesMaxChangedLines: 20_000,
  };
  const diff = await f.read("diff", options);
  assert.equal(diff.patches_withheld, true);
  assert.equal(
    diff.files.find((file: { filename: string }) => file.filename === "big.txt")
      .changes,
    2,
  );
  assert.ok(
    diff.files.every((file: { patch?: string }) => file.patch === undefined),
  );
  assert.equal(await f.read("patch", { base: "HEAD", file: "big.txt" }), "");
  if (process.platform !== "win32")
    assert.match(
      await f.read("patch", { base: "HEAD", file: "script.sh" }),
      /^old mode 100644\nnew mode 100755$/m,
    );
  f.git("restore", "big.txt", "script.sh");
  await Promise.all(
    Array.from({ length: 301 }, (_, index) =>
      f.write(`new-${index}.txt`, "one\n"),
    ),
  );
  f.git("add", ".");
  const many = await f.read("diff", options);
  assert.equal(many.patches_withheld, true);
  assert.equal(many.files.length, 301);
  assert.ok(
    many.files.every((file: { patch?: string }) => file.patch === undefined),
  );
});

test("real Git folds lazy tracked changes past 1000 while counting every tracked file", async (t) => {
  const f = await fixture(t);
  const files = Array.from(
    { length: 5000 },
    (_, index) => `tracked-${String(index).padStart(4, "0")}.txt`,
  );
  const writeTracked = async (names: string[], text: string) => {
    for (let start = 0; start < names.length; start += 100)
      await Promise.all(
        names.slice(start, start + 100).map((name) => f.write(name, text)),
      );
  };
  await writeTracked([...files, "zz-replaced.txt"], "one\n");
  f.git("add", ".");
  f.git("commit", "-m", "base");
  const options = {
    base: "HEAD",
    includePatches: false,
    inlinePatchesMaxChangedLines: 20_000,
  };
  f.git("rm", "--cached", "zz-replaced.txt");
  await f.write("zz-replaced.txt", "one\ntwo\nthree\n");
  await writeTracked(files.slice(0, 999), "one\ntwo\n");

  const atCap = await f.read("diff", options);
  assert.equal(atCap.patches_withheld, true);
  assert.equal(atCap.files.length, 1000);
  assert.equal(atCap.files[999].filename, "zz-replaced.txt");
  assert.equal(atCap.files[999].status, "removed");

  await f.write(files[999], "one\ntwo\n");
  const pastCap = await f.read("diff", options);
  assert.equal(pastCap.files.length, 1002);
  assert.deepEqual(pastCap.files[1000], {
    filename: "… and 1 more file",
    status: "modified",
    additions: 0,
    deletions: 1,
    changes: 1,
    patch: "diff --git a/… and 1 more file b/… and 1 more file\n",
  });
  assert.deepEqual(pastCap.files[1001], {
    filename: "zz-replaced.txt",
    status: "added",
    additions: 3,
    deletions: 0,
    changes: 3,
  });

  await writeTracked(files.slice(1000), "one\ntwo\n");
  const large = await f.read("diff", options);
  assert.equal(large.files.length, 1002);
  assert.equal(large.files[999].filename, files[999]);
  assert.equal(large.files[999].patch, undefined);
  assert.equal(large.files[1000].filename, "… and 4001 more files");
  assert.equal(large.files[1000].additions, 4000);
  assert.equal(large.files[1000].deletions, 1);
  const stats = await f.read("stats", { base: "HEAD" });
  assert.equal(stats.fileCount, 5001);
  assert.equal(stats.additions, 5000);
  assert.equal(stats.deletions, 1);
});

test("real Git keeps full tracked patches and folds only excess placeholders in a commit", async (t) => {
  const f = await fixture(t);
  await f.write("a-small.txt", "one\n");
  f.git("add", ".");
  f.git("commit", "-m", "base");
  const body = "line with 24 characters\n".repeat(2500);
  const files = Array.from(
    { length: 230 },
    (_, index) => `big-${String(index).padStart(3, "0")}.txt`,
  );
  await f.write("a-small.txt", "one\ntwo\n");
  await Promise.all(files.map((name) => f.write(name, body)));
  f.git("add", ".");
  f.git("commit", "-m", "large changes");
  const diff = await f.read("commit", { sha: f.git("rev-parse", "HEAD") });
  assert.equal(diff.patches_withheld, undefined);
  assert.equal(diff.files.length, 222);
  assert.match(diff.files[0].patch, /^\+two$/m);
  assert.equal(diff.files[200].filename, "big-199.txt");
  assert.equal(
    diff.files[200].patch,
    "diff --git a/big-199.txt b/big-199.txt\nnew file mode 100644\n",
  );
  assert.equal(diff.files[201].filename, "big-210.txt");
  assert.match(diff.files[201].patch, /^\+line with 24 characters$/m);
  const name = "… and 10 more files with diffs too large to display";
  assert.deepEqual(diff.files[221], {
    filename: name,
    status: "modified",
    additions: 25_000,
    deletions: 0,
    changes: 25_000,
    patch: `diff --git a/${name} b/${name}\n`,
  });
});

test("real Git reports metadata for the first 200 untracked files and lists at most 400", async (t) => {
  const f = await fixture(t);
  for (let start = 0; start < 401; start += 100)
    await Promise.all(
      Array.from({ length: Math.min(100, 401 - start) }, (_, index) =>
        f.write(
          `new-${String(start + index).padStart(3, "0")}.txt`,
          "one\ntwo\n",
        ),
      ),
    );
  await f.write("new-000.txt", "x".repeat(1024 * 1024) + "\n");
  f.git("add", "new-001.txt");
  f.git("commit", "-m", "base");
  f.git("rm", "--cached", "new-001.txt");
  const [diff, stats] = await Promise.all([
    f.read("diff", { base: "HEAD", includePatches: false }),
    f.read("stats", { base: "HEAD" }),
  ]);
  assert.equal(diff.files.length, 400);
  assert.equal(diff.files[0].filename, "new-001.txt");
  assert.equal(diff.files[0].status, "removed");
  assert.equal(diff.files[1].filename, "new-000.txt");
  assert.equal(diff.files[1].additions, 0);
  assert.equal(diff.files[199].filename, "new-199.txt");
  assert.equal(diff.files[199].additions, 2);
  assert.equal(diff.files[199].patch, undefined);
  assert.deepEqual(diff.files[200], {
    filename: "new-200.txt",
    status: "added",
    additions: 0,
    deletions: 0,
    changes: 0,
    patch: "diff --git a/new-200.txt b/new-200.txt\nnew file mode 100644\n",
  });
  assert.equal(diff.files[399].filename, "new-399.txt");
  assert.equal(stats.fileCount, 400);
  assert.equal(stats.additions, 396);
  assert.equal(stats.deletions, 2);
});

test("real SHA-256 Git repositories use their own empty tree for new files and root commits", async (t) => {
  const f = await fixture(t, "sha256");
  await f.write("first.txt", "first\n");
  const diff = await f.read("diff", { base: "HEAD" });
  assert.equal(diff.merge_base.length, 64);
  assert.equal(diff.files[0].filename, "first.txt");
  assert.deepEqual(
    await f.read("content", { base: diff.merge_base, file: "first.txt" }),
    {
      oldText: null,
      newText: "first\n",
    },
  );
  assert.match(
    await f.read("patch", { base: diff.merge_base, file: "first.txt" }),
    /\+first/,
  );
  f.git("add", ".");
  f.git("commit", "-m", "first");
  const commit = await f.read("commit", { sha: f.git("rev-parse", "HEAD") });
  assert.equal(commit.merge_base, diff.merge_base);
  assert.equal(commit.files[0].status, "added");
});

test("real Git: detached HEAD, worktree, conflict, upstream divergence and explicit head excludes working files", async (t) => {
  const f = await fixture(t);
  await f.write("a.txt", "base\n");
  f.git("add", ".");
  f.git("commit", "-m", "base");
  const base = f.git("rev-parse", "HEAD");
  f.git("checkout", "-b", "feature");
  await f.write("a.txt", "feature\n");
  f.git("commit", "-am", "feature");
  f.git("checkout", "main");
  await f.write("a.txt", "main\n");
  f.git("commit", "-am", "main");
  f.git("remote", "add", "origin", "https://example.invalid/repo.git");
  f.git("update-ref", "refs/remotes/origin/main", "main");
  f.git("checkout", "feature");
  f.git("branch", "--set-upstream-to=origin/main");
  const row = await f.read("state");
  assert.equal(row.ahead, 1);
  assert.equal(row.behind, 1);
  await f.write("untracked.txt", "untracked\n");
  assert.equal(
    (await f.read("diff", { base: "main", head: "feature" })).files.some(
      (x: any) => x.filename === "untracked.txt",
    ),
    false,
  );
  try {
    f.git("merge", "main", "--no-edit");
  } catch {}
  assert.equal((await f.read("state")).conflicted, true);
  f.git("merge", "--abort");
  f.git("checkout", "--detach", base);
  assert.equal((await f.read("state")).branch, undefined);
  const worktree = path.join(f.cwd, "linked");
  f.git("worktree", "add", "--detach", worktree, base);
  assert.equal(
    ((await readOfficialGit({ kind: "info", cwd: worktree })) as any).root,
    await fs.realpath(worktree),
  );
});

test("Git IPC validates paths and authorizes before any read; symlink escape is refused", async (t) => {
  const f = await fixture(t);
  const handlers = new Map<string, any>();
  registerOfficialGitHandlers((name, fn) => handlers.set(name, fn), {
    allowedFolder(cwd: string) {
      assert.equal(cwd, f.cwd, "unauthorized folder");
    },
  } as never);
  const call = handlers.get("officialGitRead");
  assert.throws(
    () => call({ kind: "state", cwd: os.homedir() }),
    /unauthorized/,
  );
  for (const file of [
    "../private",
    "/etc/passwd",
    ":(glob)**",
    ".git/config",
    "C:/private",
  ]) {
    // A colon filename is safe with literal pathspecs; magic syntax must never be interpreted.
    if (file.startsWith(":")) continue;
    assert.throws(() =>
      call({ kind: "content", cwd: f.cwd, base: "HEAD", file }),
    );
  }
  assert.throws(() =>
    call({ kind: "diff", cwd: f.cwd, base: "--output=somewhere" }),
  );
  await f.write("a.txt", "one\n");
  f.git("add", ".");
  f.git("commit", "-m", "one");
  const outside = await fs.mkdtemp(
    path.join(os.tmpdir(), "claudex-git-private-"),
  );
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "secret"), "secret");
  await fs.symlink(outside, path.join(f.cwd, "escape"));
  await assert.rejects(
    call({ kind: "content", cwd: f.cwd, base: "HEAD", file: "escape/secret" }),
    /outside/,
  );
  assert.deepEqual(await call({ kind: "changes", cwd: f.cwd }), ["escape"]);
  await fs.symlink("a.txt", path.join(f.cwd, "link.txt"));
  assert.deepEqual(
    await call({ kind: "content", cwd: f.cwd, base: "HEAD", file: "link.txt" }),
    { oldText: null, newText: "a.txt" },
  );
});

test("native Git uses the real authorized IPC, updates branches, removes subscriptions on account change and disposes", async (t) => {
  const f = await fixture(t);
  const nonGit = await fs.mkdtemp(path.join(os.tmpdir(), "claudex-non-git-"));
  t.after(() => fs.rm(nonGit, { recursive: true, force: true }));
  await f.write("a.txt", "one\n");
  f.git("add", ".");
  f.git("commit", "-m", "one");
  const id = "b4e965cc-410d-461c-a235-64996fa2043a";
  const ipc = new Map<string, any>(),
    handlers = new Map<string, any>(),
    events: any[] = [];
  ipc.set(
    "officialCodeWorktreeLifecycle",
    ({ sessionId }: { sessionId: string }) => {
      if (sessionId !== id) throw Error("Code session not found");
      return null;
    },
  );
  registerOfficialGitHandlers((name, fn) => ipc.set(name, fn), {
    allowedFolder(cwd: string) {
      if (cwd !== f.cwd && cwd !== nonGit) throw Error("unauthorized");
    },
  } as never);
  let identity = {},
    listener: any;
  const stop = registerGit({
    ctx: {
      account: () => ({ id: "a" }),
      sessionIdentity: () => identity,
      localCall: async (name: string, ...args: any[]) => ipc.get(name)(...args),
      localLoadConversation: async (key: string) =>
        key === id ? { id, cwd: f.cwd, mode: "code" } : undefined,
      onEvent(fn: any) {
        listener = fn;
        return () => {};
      },
    },
    on(name: string, fn: any) {
      handlers.set(name, fn);
    },
    emit: (...args: any[]) => events.push(args),
  } as never);
  t.after(stop);
  assert.equal(
    (await handlers.get("GitState.getGitStateSnapshot")([f.cwd]))[0].branch,
    "main",
  );
  await assert.rejects(
    handlers.get("GitState.getGitStateSnapshot")([os.homedir()]),
    /unauthorized/,
  );
  await assert.rejects(
    handlers.get("LocalSessions.getUncommittedChanges")("local_missing"),
  );
  await f.write("new.txt", "new\n");
  assert.equal(
    await handlers.get("LocalSessions.getWorkingTreeDirtyState")(f.cwd),
    "dirty",
  );
  assert.equal(
    await handlers.get("LocalSessions.getWorkingTreeDirtyState")(nonGit),
    "clean",
  );
  assert.equal(
    await handlers.get("LocalSessions.isWorkingTreeDirty")(nonGit),
    false,
  );
  const configPath = path.join(f.cwd, ".git", "config");
  const config = await fs.readFile(configPath);
  await fs.writeFile(configPath, "[invalid\n");
  try {
    assert.equal(
      await handlers.get("LocalSessions.getWorkingTreeDirtyState")(f.cwd),
      "unknown",
    );
    assert.equal(
      await handlers.get("LocalSessions.isWorkingTreeDirty")(f.cwd),
      true,
    );
  } finally {
    await fs.writeFile(configPath, config);
  }
  assert.equal(
    await handlers.get("LocalSessions.isWorkingTreeDirty")(f.cwd),
    true,
  );
  assert.equal(
    (await handlers.get("LocalSessions.getGitInfo")(f.cwd)).branch,
    "main",
  );
  assert.deepEqual(await handlers.get("LocalSessions.getGitInfo")(f.cwd), {
    repo: "",
    branch: "main",
    root: await fs.realpath(f.cwd),
  });
  f.git("remote", "add", "origin", "git@github.com:fixture/desktop.git");
  f.git("update-ref", "refs/remotes/origin/main", "HEAD");
  f.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  assert.deepEqual(await handlers.get("LocalSessions.getGitInfo")(f.cwd), {
    repo: "fixture/desktop",
    branch: "main",
    defaultBranch: "main",
    remote: { hostname: "github.com", owner: "fixture", name: "desktop" },
    root: await fs.realpath(f.cwd),
  });
  assert.deepEqual(
    await handlers.get("LocalSessions.getLocalBranches")(f.cwd),
    ["main"],
  );
  const diff = await handlers.get("LocalSessions.getGitDiff")(
    f.cwd,
    "HEAD",
    undefined,
    { includePatches: false },
  );
  assert.equal(diff.files[0].filename, "new.txt");
  assert.equal(diff.files[0].patch, undefined);
  assert.equal(
    (await handlers.get("LocalSessions.getGitDiffStats")(f.cwd, "HEAD"))
      .additions,
    1,
  );
  assert.deepEqual(
    await handlers.get("LocalSessions.getDiffFileContent")(
      f.cwd,
      "HEAD",
      "new.txt",
    ),
    { oldText: null, newText: "new\n" },
  );
  assert.match(
    await handlers.get("LocalSessions.getGitDiffFilePatch")(
      f.cwd,
      "HEAD",
      "new.txt",
    ),
    /\+new/,
  );
  assert.deepEqual(
    await handlers.get("LocalSessions.getGitCommits")(f.cwd, "HEAD"),
    [],
  );
  assert.equal(
    (
      await handlers.get("LocalSessions.getCommitDiff")(
        f.cwd,
        f.git("rev-parse", "HEAD"),
      )
    ).files[0].filename,
    "a.txt",
  );
  assert.deepEqual(
    await handlers.get("LocalSessions.getUncommittedChangesByFolder")(
      `local_${id}`,
    ),
    null,
  );
  await handlers.get("LocalSessions.refreshGitState")(`local_${id}`);
  await handlers.get("LocalSessions.invalidateGitDiffCache")(`local_${id}`);
  assert.deepEqual(
    await handlers.get("LocalSessions.getUncommittedChanges")(`local_${id}`),
    null,
  );
  await fs.rm(path.join(f.cwd, "new.txt"));
  assert.equal(
    await handlers.get("LocalSessions.getWorkingTreeDirtyState")(f.cwd),
    "clean",
  );
  const oldImage = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jqYQAAAAASUVORK5CYII=",
    "base64",
  );
  const newImage = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/yq5zsAAAAABJRU5ErkJggg==",
    "base64",
  );
  const image = handlers.get("LocalSessions.getDiffFileImage");
  await fs.writeFile(path.join(f.cwd, "before.png"), oldImage);
  f.git("add", "before.png");
  f.git("commit", "-m", "image");
  const rev = f.git("rev-parse", "HEAD");
  f.git("mv", "before.png", "after.PNG");
  await fs.writeFile(path.join(f.cwd, "after.PNG"), newImage);
  assert.equal(
    await image({ cwd: f.cwd, rev, filePath: "before.png" }),
    `data:image/png;base64,${oldImage.toString("base64")}`,
  );
  assert.equal(
    await image({ cwd: f.cwd, filePath: "after.PNG" }),
    `data:image/png;base64,${newImage.toString("base64")}`,
  );
  assert.equal(await image({ cwd: f.cwd, filePath: "before.png" }), null);
  assert.equal(await image({ cwd: f.cwd, filePath: "a.txt" }), null);
  await assert.rejects(
    image({ cwd: os.homedir(), filePath: "x.png" }),
    /unauthorized/,
  );
  f.git("checkout", "-b", "live-branch");
  for (
    let i = 0;
    i < 60 && !events.some((e) => e[2]?.[0]?.branch === "live-branch");
    i++
  )
    await new Promise((r) => setTimeout(r, 100));
  assert.ok(
    events.some(
      (e) =>
        e[0] === "GitState" &&
        e[1] === "gitStateChanged" &&
        e[2]?.[0]?.branch === "live-branch",
    ),
  );
  identity = {};
  listener({ type: "snapshot" });
  assert.deepEqual(events.at(-1), ["GitState", "gitStateChanged", [], [f.cwd]]);
  stop();
});

test(
  "native SSH Git reads the saved host's authorized repository",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    await f.write("tracked.txt", "base\n");
    f.git("add", ".");
    f.git("commit", "-m", "base");
    f.git("remote", "add", "origin", "git@github.com:fixture/remote.git");
    f.git("update-ref", "refs/remotes/origin/main", "HEAD");
    f.git(
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    );
    f.git("checkout", "-b", "feature");
    await f.write("tracked.txt", "base\ncommitted\n");
    f.git("commit", "-am", "remote commit");
    const sha = f.git("rev-parse", "HEAD");
    await f.write("tracked.txt", "base\ncommitted\nworking\n");
    await f.write("new.txt", "remote untracked\n");
    const sshConfig = { sshHost: "fixture", sshPort: 2222, remoteCwd: f.cwd };
    const ipc = new Map<string, any>(),
      handlers = new Map<string, any>();
    let connected = true;
    const savedHost = { id: "saved", destination: "fixture", port: 2222 };
    const wrongHost = { ...savedHost, id: "other", port: 2223 };
    registerOfficialGitHandlers((name, fn) => ipc.set(name, fn), {
      allowedFolder(cwd: string, environment?: { hostId: string }) {
        if (cwd !== f.cwd || environment?.hostId !== savedHost.id)
          throw Error("unauthorized");
      },
      services: {
        ssh: {
          allowed: () => true,
          hosts: {
            list: () => [wrongHost, savedHost],
            get: (id: string) => (id === savedHost.id ? savedHost : wrongHost),
          },
          existing: () =>
            connected
              ? {
                  status: { state: "ready" },
                  async exec(script: string) {
                    const result = spawnSync("/bin/sh", ["-c", script], {
                      encoding: "utf8",
                    });
                    return {
                      code: result.status,
                      stdout: result.stdout,
                      stderr: result.stderr,
                    };
                  },
                }
              : undefined,
        },
      },
      engines: { all: () => [] },
    } as never);
    t.after(
      registerGit({
        ctx: {
          account: () => ({ id: "a" }),
          localCall: async (name: string, ...args: unknown[]) =>
            ipc.get(name)(...args),
          onEvent: () => () => {},
        },
        on: (name: string, fn: unknown) => handlers.set(name, fn),
        emit: () => {},
      } as never),
    );
    const read = (method: string, ...args: unknown[]) =>
      handlers.get(`LocalSessions.${method}`)(sshConfig, f.cwd, ...args);
    assert.deepEqual(await read("getSSHGitInfo"), {
      branch: "feature",
      repo: "fixture/remote",
      defaultBranch: "main",
      root: await fs.realpath(f.cwd),
    });
    assert.deepEqual((await read("getSSHLocalBranches")).sort(), [
      "feature",
      "main",
    ]);
    const diff = await read("getSSHGitDiff", "main");
    assert.equal(diff.ahead_by, 1);
    assert.match(
      diff.files.find(
        (file: { filename: string }) => file.filename === "new.txt",
      ).patch,
      /\+remote untracked/,
    );
    assert.equal((await read("getSSHGitDiffStats", "main")).fileCount, 2);
    assert.equal((await read("getSSHGitCommits", "main"))[0].sha, sha);
    assert.match(
      (await read("getSSHCommitDiff", sha)).files[0].patch,
      /\+committed/,
    );
    assert.deepEqual(
      await read("getSSHDiffFileContent", diff.merge_base, "tracked.txt"),
      {
        oldText: "base\n",
        newText: "base\ncommitted\nworking\n",
      },
    );
    assert.equal(
      await handlers.get("LocalSessions.getSSHGitInfo")(
        { ...sshConfig, sshPort: 2223 },
        f.cwd,
      ),
      null,
    );
    assert.equal(
      await handlers.get("LocalSessions.getSSHGitInfo")(
        sshConfig,
        os.homedir(),
      ),
      null,
    );
    await assert.rejects(
      handlers.get("LocalSessions.getGitInfo")(f.cwd),
      /unauthorized/,
    );
    connected = false;
    assert.equal(await read("getSSHGitDiff", "main"), null);
    assert.deepEqual(await read("getSSHLocalBranches"), []);
  },
);

test("native Git rejects late results after an account is retired", async () => {
  let identity = {},
    finish!: (v: any) => void;
  const handlers = new Map<string, any>(),
    events: any[] = [];
  const stop = registerGit({
    ctx: {
      account: () => ({ id: "a" }),
      sessionIdentity: () => identity,
      localCall: () =>
        new Promise((r) => {
          finish = r;
        }),
      onEvent: () => () => {},
    },
    on(name: string, fn: any) {
      handlers.set(name, fn);
    },
    emit: (...args: any[]) => events.push(args),
  } as never);
  try {
    const pending = handlers.get("GitState.getGitStateSnapshot")([
      "/authorized",
    ]);
    identity = {};
    finish({ cwd: "/authorized", branch: "private", conflicted: false });
    await assert.rejects(pending, /account changed/);
    assert.deepEqual(events, []);
  } finally {
    stop();
  }
});
