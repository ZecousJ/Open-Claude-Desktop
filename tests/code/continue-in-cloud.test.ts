/**
 * Continue in cloud: the plan read from a real checkout, the work saved as a
 * commit without touching the folder's index or branches, the upload to the
 * session's own ref with a leased credential that never reaches argv or the
 * person's folder, the run's steps and retries, and the router that gives the
 * upload its lease only with the cloud on.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildSnapshot,
  commonGitDir,
  fileUrl,
  looksSecretLike,
  readCensus,
  readContinuationPlan,
  transportRef,
} from "../../electron/cloud/continue-in-cloud";
import {
  classifyPushFailure,
  transportPreamble,
  uploadForCloud,
  type PushGit,
  type PushRun,
} from "../../electron/cloud/cloud-upload";
import { localWorkingTree } from "../../electron/git/working-tree";
import { CloudRouter } from "../../electron/cloud/cloud-router";
import { registerCloudContinueHandlers } from "../../electron/ipc/cloud-continue";
import {
  canAskToPush,
  offersPullAndPush,
  pullAndPushPrompt,
  continuationDescription,
  firstMessage,
  runContinuation,
  type Segment,
} from "../../src/app/continue-in-cloud";
import { armResume, takeResume } from "../../src/app/continue-resume";
import type { CloudContinuationPlan } from "../../shared/cloud-continue-api";
import type { Conversation } from "../../shared/types";

const TOKEN = "gho_SECRET_push_token";
const identity = {
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.test",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...identity },
    encoding: "utf8",
  });

function checkout() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "continue-cloud-"));
  git(dir, "init", "--quiet", "-b", "feature/x");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "--quiet", "-m", "one");
  return dir;
}

const text = (description: Segment[][]) =>
  description
    .map((paragraph) =>
      paragraph
        .map((part) => (typeof part === "string" ? part : `\`${part.code}\``))
        .join(""),
    )
    .join("\n");

test("the plan reads origin's repository, what comes along and what stays", async () => {
  const dir = checkout();
  const read = (includeUntracked = true) =>
    readContinuationPlan(localWorkingTree.git, dir, includeUntracked);
  assert.deepEqual(await read(), {
    kind: "unsupported",
    reason: "noRemote",
    branch: "feature/x",
  });
  git(dir, "remote", "add", "origin", "https://gitlab.com/acme/tool.git");
  assert.equal(((await read()) as { reason: string }).reason, "noGitHub");
  git(dir, "remote", "set-url", "origin", "git@github.com:acme/tool.git");
  // A clean folder: nothing comes along, origin's copy unknown.
  assert.deepEqual(await read(), {
    kind: "ready",
    repository: "acme/tool",
    branch: "feature/x",
    trackedChanges: 0,
    untrackedIncluded: 0,
    leftBehind: [],
    leftBehindCount: 0,
    unchecked: [],
    uncheckedCount: 0,
  });
  git(dir, "update-ref", "refs/remotes/origin/feature/x", "HEAD");
  fs.writeFileSync(path.join(dir, "a.txt"), "b\n");
  git(dir, "commit", "--quiet", "-am", "two");
  // Uncommitted edits, a new file, a secret and a large file.
  fs.writeFileSync(path.join(dir, "a.txt"), "c\n");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "new.ts"), "n\n");
  fs.writeFileSync(path.join(dir, ".env"), "KEY=1\n");
  fs.writeFileSync(path.join(dir, ".env.example"), "KEY=\n");
  fs.writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(11 * 1024 * 1024));
  const plan = await read();
  assert.deepEqual(plan, {
    kind: "ready",
    repository: "acme/tool",
    branch: "feature/x",
    trackedChanges: 1,
    untrackedIncluded: 2,
    aheadOfUpstream: 1,
    leftBehind: [".env", "big.bin"],
    leftBehindCount: 2,
    unchecked: [],
    uncheckedCount: 0,
  });
  assert.equal(
    text(continuationDescription(plan)),
    [
      "Claudex picks up where you left off in a new cloud session, with your work exactly as it is now.",
      "3 uncommitted changes come along. 1 unpushed commit rides along. Your work is uploaded to `acme/tool` on GitHub. Nothing is pushed to your branch. This session stays on this computer.",
      "2 untracked files stay on this computer because they look like secrets or are over 10 MB: `.env`, `big.bin`. Stage a file with git add to bring it along.",
    ].join("\n"),
  );
  // Without untracked files only the edit comes along.
  assert.equal(
    ((await read(false)) as { untrackedIncluded: number }).untrackedIncluded,
    0,
  );
  // A merge under way, then conflicts, block the move.
  fs.writeFileSync(path.join(dir, ".git", "MERGE_HEAD"), "x\n");
  assert.deepEqual(await read(), {
    kind: "blocked",
    blocker: "operation_in_progress",
    operation: "merge",
  });
  fs.rmSync(path.join(dir, ".git", "MERGE_HEAD"));
  assert.equal(
    await commonGitDir(localWorkingTree.git, dir),
    fs.realpathSync(path.join(dir, ".git")),
  );
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "continue-plain-"));
  assert.deepEqual(await readContinuationPlan(localWorkingTree.git, plain), {
    kind: "unsupported",
    reason: "noGit",
  });
  assert.ok(looksSecretLike("config/.ssh/known_hosts"));
  assert.ok(looksSecretLike("deploy/server.pem"));
  assert.ok(!looksSecretLike(".env.sample"));
});

test("too many untracked files block the move until they are left out", async () => {
  const dir = checkout();
  git(dir, "remote", "add", "origin", "https://github.com/acme/tool.git");
  fs.mkdirSync(path.join(dir, "node_modules"));
  for (let i = 0; i < 2001; i++)
    fs.writeFileSync(path.join(dir, "node_modules", `f${i}`), "");
  const plan = await readContinuationPlan(localWorkingTree.git, dir);
  assert.deepEqual(plan, {
    kind: "blocked",
    blocker: "too_many_untracked",
    untrackedCount: 2001,
    topDirs: ["node_modules"],
  });
  assert.equal(
    text(continuationDescription(plan)),
    "2001 untracked files here aren’t ignored by git (`node_modules`), which is more than a move can carry. Add them to .gitignore, or continue without untracked files.",
  );
  assert.equal(
    (await readContinuationPlan(localWorkingTree.git, dir, false)).kind,
    "ready",
  );
});

test("the work is saved as a commit on HEAD; the folder's index and branch stay", async () => {
  const dir = checkout();
  git(dir, "remote", "add", "origin", "https://github.com/acme/tool.git");
  const head = git(dir, "rev-parse", "HEAD").trim();
  const census = async () => {
    const result = await readCensus(localWorkingTree.git, dir);
    assert.equal(result.kind, "ready");
    return (result as Extract<typeof result, { kind: "ready" }>).folder;
  };
  // Nothing uncommitted: the tip is HEAD.
  assert.deepEqual(await buildSnapshot(await census()), {
    tip: head,
    snapshot: false,
  });
  fs.writeFileSync(path.join(dir, "a.txt"), "edited\n");
  fs.writeFileSync(path.join(dir, "new.txt"), "new\n");
  fs.writeFileSync(path.join(dir, "id_rsa"), "secret\n");
  git(dir, "add", "new.txt");
  const statusBefore = git(dir, "status", "--porcelain");
  const saved = await buildSnapshot(await census());
  assert.equal(saved.snapshot, true);
  assert.notEqual(saved.tip, head);
  // The commit holds the work (the secret stays out) on top of HEAD.
  assert.equal(git(dir, "rev-parse", `${saved.tip}^`).trim(), head);
  assert.equal(git(dir, "show", `${saved.tip}:a.txt`), "edited\n");
  assert.equal(git(dir, "show", `${saved.tip}:new.txt`), "new\n");
  assert.throws(() =>
    execFileSync("git", ["cat-file", "-e", `${saved.tip}:id_rsa`], {
      cwd: dir,
      stdio: "ignore",
    }),
  );
  assert.match(
    git(dir, "log", "-1", "--format=%s", saved.tip),
    /WIP: uncommitted changes, moved to the cloud/,
  );
  // The folder is as it was: same status, same branch tip.
  assert.equal(git(dir, "status", "--porcelain"), statusBefore);
  assert.equal(git(dir, "rev-parse", "HEAD").trim(), head);
  // The same work saves as the same commit.
  assert.equal((await buildSnapshot(await census())).tip, saved.tip);
  assert.match(
    transportPreamble({ branch: "feature/x", snapshot: true, tip: saved.tip }),
    new RegExp(`\`feature/x\` branch.*top commit ${saved.tip.slice(0, 12)}`),
  );
});

const lease =
  (over: Record<string, unknown> = {}) =>
  async () => ({
    url: "https://github.com/acme/tool.git",
    username: "x-access-token",
    token: TOKEN,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    repository: "acme/tool",
    defaultBranch: "main",
    canPush: true,
    ...over,
  });

/** Real git, with GitHub's address standing for a local bare repository. */
const toLocal =
  (remote: string, runs: PushRun[]): PushGit =>
  (run) =>
    new Promise((resolve) => {
      runs.push(run);
      const argv = run.argv.map((arg) =>
        arg === "https://github.com/acme/tool.git" ? fileUrl(remote) : arg,
      );
      execFile(
        "git",
        ["-c", "protocol.file.allow=always", ...argv],
        { env: run.env },
        (error, stdout, stderr) =>
          resolve({
            code: error ? 1 : 0,
            stdout: String(stdout),
            stderr: String(stderr),
          }),
      );
    });

test("the upload pushes the saved commit to the session's own ref, with the lease, from a repository of its own", async () => {
  const dir = checkout();
  git(dir, "remote", "add", "origin", "https://github.com/acme/tool.git");
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "continue-remote-"));
  git(remote, "init", "--quiet", "--bare");
  fs.writeFileSync(path.join(dir, "a.txt"), "edited\n");
  const census = await readCensus(localWorkingTree.git, dir);
  assert.equal(census.kind, "ready");
  const folder = (census as Extract<typeof census, { kind: "ready" }>).folder;
  const saved = await buildSnapshot(folder);
  const ref = transportRef("conversation-1");
  assert.match(ref, /^refs\/claudex-continue\/[0-9a-f]{16}$/);
  const runs: PushRun[] = [];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "continue-temp-"));
  const gitDir = await commonGitDir(localWorkingTree.git, dir);
  const upload = (alreadyUploaded = false) =>
    uploadForCloud({
      gitDir,
      tip: saved.tip,
      snapshot: true,
      branch: "feature/x",
      repository: "acme/tool",
      ref,
      lease: lease(),
      tempRoot: temp,
      run: toLocal(remote, runs),
      alreadyUploaded,
    });
  assert.deepEqual(await upload(), {
    repository: {
      url: "https://github.com/acme/tool.git",
      ref,
      branch: "feature/x",
    },
  });
  // origin has the work at the session's ref, and no branch of the person's.
  assert.equal(git(remote, "rev-parse", ref).trim(), saved.tip);
  assert.equal(git(remote, "branch", "--list").trim(), "");
  const push = runs.find((run) => run.argv.includes("push"))!;
  assert.ok(push.argv.includes(`core.hooksPath=${os.devNull}`));
  assert.ok(push.argv.includes(`+refs/heads/work:${ref}`));
  for (const run of runs) {
    assert.ok(!run.argv.join(" ").includes(TOKEN));
    assert.equal(run.env.GIT_CONFIG_NOSYSTEM, "1");
  }
  // The fetch from the folder carries no credential.
  const fetch = runs.find((run) => run.argv.includes("fetch"))!;
  assert.equal(fetch.env.CLAUDEX_GIT_TOKEN, undefined);
  assert.equal(push.env.CLAUDEX_GIT_TOKEN, TOKEN);
  assert.deepEqual(fs.readdirSync(temp), []);
  // Already there: nothing is pushed again.
  runs.length = 0;
  await upload();
  assert.ok(!runs.some((run) => run.argv.includes("push")));
});

test("a clean folder whose branch origin has starts from the branch; a refused upload says why", async () => {
  const runs: PushRun[] = [];
  const tip = "a".repeat(40);
  const listing: PushGit = async (run) => {
    runs.push(run);
    if (run.argv.includes("ls-remote"))
      return {
        code: 0,
        stdout: `${tip}\trefs/heads/feature/x\n`,
        stderr: "",
      };
    return { code: 0, stderr: "" };
  };
  const base = {
    gitDir: "/w/.git",
    tip,
    snapshot: false,
    branch: "feature/x",
    repository: "acme/tool",
    ref: transportRef("c1"),
    lease: lease(),
  };
  assert.deepEqual(await uploadForCloud({ ...base, run: listing }), {
    repository: { url: "https://github.com/acme/tool.git", ref: "feature/x" },
  });
  assert.equal(runs.length, 1);
  const refusing: PushGit = async (run) =>
    run.argv.includes("push")
      ? {
          code: 1,
          stderr: `error: failed to push to https://x-access-token:${TOKEN}@github.com/acme/tool.git\nfatal: Authentication failed`,
        }
      : { code: 0, stdout: "", stderr: "" };
  await assert.rejects(
    uploadForCloud({ ...base, snapshot: true, run: refusing }),
    (error: Error & { failure?: string; excerpt?: string; command?: string }) =>
      error.failure === "auth" &&
      /didn’t accept the upload/.test(error.message) &&
      !error.excerpt!.includes(TOKEN) &&
      error.command ===
        `git push --no-follow-tags https://github.com/acme/tool.git +${tip}:${base.ref}`,
  );
  // Pushed outside this app: trusted, and marked so.
  assert.deepEqual(
    await uploadForCloud({
      ...base,
      snapshot: true,
      run: refusing,
      alreadyUploaded: true,
    }),
    {
      repository: {
        url: "https://github.com/acme/tool.git",
        ref: base.ref,
        branch: "feature/x",
      },
      unverified: true,
    },
  );
  await assert.rejects(
    uploadForCloud({ ...base, lease: lease({ canPush: false }) }),
    (error: Error & { failure?: string }) => error.failure === "auth",
  );
  assert.equal(
    classifyPushFailure("Could not resolve host: github.com", false),
    "network",
  );
  assert.equal(
    classifyPushFailure(
      "! [remote rejected] x (pre-receive hook declined)",
      false,
    ),
    "remote_rejected",
  );
  assert.equal(classifyPushFailure("", true), "timed_out");
  assert.equal(fileUrl("C:\\work\\.git"), "file:///C:/work/.git");
});

test("the run saves, uploads, writes the note and starts the cloud session; a retry resumes", async () => {
  const conversation = {
    id: "c1",
    title: "Fix the parser",
    mode: "code",
    providerId: "sub2api",
    model: "gpt-5.5",
  } as Conversation;
  const steps: string[] = [];
  const calls: string[] = [];
  let failSend = true;
  const sent: unknown[] = [];
  const repository = {
    url: "https://github.com/acme/tool.git",
    ref: "refs/claudex-continue/0123456789abcdef",
    branch: "feature/x",
  };
  const api = {
    saveWorkForCloud: async () => {
      calls.push("save");
      return {
        tip: "a".repeat(40),
        snapshot: true,
        branch: "feature/x",
        repository: "acme/tool",
      };
    },
    uploadWorkForCloud: async () => {
      calls.push("upload");
      return { ok: true as const, repository, preamble: "[Moved]" };
    },
    writeHandOffNote: async () => {
      calls.push("note");
      return { title: "Fix the parser", note: "Goal: fix it.", written: true };
    },
    send: async (input: unknown) => {
      calls.push("send");
      sent.push(input);
      if (failSend) throw new Error("The cloud did not answer in time.");
      return { id: "cloud-1" } as Conversation;
    },
  };
  const progress = {};
  const run = () =>
    runContinuation({
      api,
      conversation,
      includeUntracked: true,
      progress,
      onStep: (step) => steps.push(step),
    });
  assert.deepEqual(await run(), {
    failed: {
      step: "creating_session",
      message: "The cloud did not answer in time.",
    },
  });
  failSend = false;
  assert.deepEqual(await run(), {
    created: { id: "cloud-1" },
    unverified: false,
  });
  // The retry did not save, upload or write the note again.
  assert.deepEqual(calls, ["note", "save", "upload", "send", "send"]);
  assert.deepEqual(steps, [
    "saving_work",
    "uploading",
    "generating_summary",
    "creating_session",
    "creating_session",
  ]);
  const input = sent.at(-1) as Record<string, unknown>;
  assert.deepEqual(input.repository, repository);
  assert.equal(input.mode, "code");
  assert.match(String(input.text), /^\[Moved\]\n\n/);
  assert.match(String(input.text), /<handoff-note>\n\nGoal: fix it\./);
  assert.equal(
    firstMessage(
      { title: "t", note: "n", written: true },
      undefined,
    ).startsWith("[Moved"),
    false,
  );

  // A refused upload stops there, with git's words and the push to ask for.
  const refused = await runContinuation({
    api: {
      ...api,
      uploadWorkForCloud: async () => ({
        ok: false as const,
        failure: "auth" as const,
        message: "The remote didn’t accept the upload from this app.",
        excerpt: "fatal: denied",
        command:
          "git push --no-follow-tags https://github.com/acme/tool.git +a:b",
      }),
    },
    conversation,
    includeUntracked: true,
    progress: {},
    onStep: () => {},
  });
  assert.ok("failed" in refused && refused.failed.step === "uploading");
  assert.equal(canAskToPush((refused as { failed: never }).failed), true);
  // A refused save goes back to the plan.
  const changed = await runContinuation({
    api: {
      ...api,
      saveWorkForCloud: async () => {
        throw new Error("Your files or origin may have changed.");
      },
    },
    conversation,
    includeUntracked: true,
    progress: {},
    onStep: () => {},
  });
  assert.deepEqual(changed, {
    failed: {
      step: "saving_work",
      message: "Your files or origin may have changed.",
    },
  });
});

test("the dialog comes back only once the asked turn has ended", () => {
  const session = (status: string, turns: number) =>
    ({
      id: "c9",
      turns: Array.from({ length: turns }, () => ({ status })),
    }) as unknown as Conversation;
  armResume("c9", { includeUntracked: false, turns: 3 });
  // The window has not seen the asked turn yet.
  assert.equal(takeResume(session("completed", 2)), undefined);
  assert.equal(takeResume(session("inProgress", 3)), undefined);
  assert.deepEqual(takeResume(session("completed", 3)), {
    includeUntracked: false,
  });
  assert.equal(takeResume(session("completed", 3)), undefined);
});

test("the router gives the upload its lease only with the cloud on", async () => {
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  let online = true;
  const router = new CloudRouter({
    client: () =>
      online
        ? {
            call: async () => undefined,
            snapshot: async () => ({ snapshot: {} as never }),
            json: async (path: string, init?: RequestInit) => {
              requests.push({ path, init });
              return { code: 0, data: { token: "t" } };
            },
          }
        : undefined,
    push: () => {},
    attachmentBytes: async () => undefined,
  });
  let leased: unknown;
  const local = async (id: unknown, options: unknown, lease: unknown) => {
    assert.equal(id, "c1");
    assert.deepEqual(options, { alreadyUploaded: true });
    assert.equal(typeof lease, "function");
    leased = await (lease as (r: string) => Promise<unknown>)("acme/tool");
    return "uploaded";
  };
  assert.equal(
    await router.route("uploadWorkForCloud", local)("c1", {
      alreadyUploaded: true,
    }),
    "uploaded",
  );
  assert.deepEqual(leased, { token: "t" });
  assert.equal(requests[0]!.path, "/api/v1/claudex/web/github/push-grant");
  assert.equal(requests[0]!.init!.method, "POST");
  const plan = router.route("cloudContinuationPlan", async () => "local plan");
  assert.equal(await plan("c1"), "local plan");
  online = false;
  assert.deepEqual(await plan("c1"), {
    kind: "unsupported",
    reason: "signedOut",
  });
  assert.throws(
    () => router.route("uploadWorkForCloud", local)("c1"),
    /Sign in/,
  );
});

test("a window's own call never uploads, and only a local Code session's folder is read", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const sessions: Record<string, Partial<Conversation>> = {
    local: { id: "local", mode: "code", cwd: "/nowhere" },
    chat: { id: "chat", mode: "chat" },
    ssh: {
      id: "ssh",
      mode: "code",
      cwd: "/x",
      environment: { kind: "ssh", hostId: "h" } as Conversation["environment"],
    },
  };
  registerCloudContinueHandlers((name, fn) => handlers.set(name, fn), {
    store: {
      conversation: (id: string) => sessions[id] as Conversation,
    } as never,
    engine: {
      writeHandOffNote: async (id: string) => ({
        title: id,
        note: "n",
        written: true,
      }),
    } as never,
  });
  await assert.rejects(
    async () =>
      handlers.get("uploadWorkForCloud")!("local", {}, "not a function"),
    /Sign in/,
  );
  // Nothing saved yet: nothing to upload.
  await assert.rejects(
    async () =>
      handlers.get("uploadWorkForCloud")!("local", {}, async () => ({})),
    /may have changed/,
  );
  assert.deepEqual(await handlers.get("cloudContinuationPlan")!("chat"), {
    kind: "unsupported",
    reason: "elsewhere",
  });
  assert.deepEqual(await handlers.get("cloudContinuationPlan")!("ssh"), {
    kind: "unsupported",
    reason: "elsewhere",
  });
  await assert.rejects(
    async () => handlers.get("saveWorkForCloud")!("ssh"),
    /can’t be moved/,
  );
  const plan: CloudContinuationPlan = { kind: "unsupported", reason: "noGit" };
  assert.equal(
    text(continuationDescription(plan)),
    "This session can’t be moved to the cloud from here.",
  );
});

test("a branch behind its remote is answered by Pull and push", () => {
  const behind = {
    step: "uploading",
    failure: "non_fast_forward",
    message: "x",
  } as const;
  assert.equal(offersPullAndPush(behind), true);
  assert.equal(offersPullAndPush({ ...behind, failure: "auth" }), false);
  assert.equal(offersPullAndPush(undefined), false);
  assert.match(pullAndPushPrompt, /stop and tell me instead of resolving them/);
});
