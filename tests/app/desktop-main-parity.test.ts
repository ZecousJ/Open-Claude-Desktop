import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { reactComponentInspection } from "../../electron/browser/react-inspection";
import { PreviewStream } from "../../electron/artifacts/preview-stream";
import {
  keepCrashStack,
  recordGpuExit,
  startNativeCrashes,
} from "../../electron/support/native-crashes";
import { CoworkMemoryFiles } from "../../electron/memory/cowork-files";
import { githubReview } from "../../electron/git/github-review";
import { githubReviewInput } from "../../shared/github-review-input";

test("preview React inspection finds the owner, bounds props and tolerates hostile getters", () => {
  const inspect = vm.runInNewContext(`(${reactComponentInspection})`);
  function SaveButton() {}
  const props = {
    label: "Save",
    children: "ignored",
    ref: null,
    count: 2,
    onClick() {},
  };
  Object.defineProperty(props, "broken", {
    enumerable: true,
    get() {
      throw new Error("untrusted");
    },
  });
  const component = { tag: 0, type: SaveButton, memoizedProps: props };
  const node = { __reactFiber$test: { tag: 5, return: component } };
  const result = inspect.call(node, { source: false, extent: false });
  assert.equal(result.name, "SaveButton");
  assert.equal(result.props.label, "Save");
  assert.equal(result.props.count, 2);
  assert.equal(result.props.broken, "[unreadable]");
  assert.equal(result.props.children, undefined);
  assert.equal(inspect.call({}, { source: false, extent: false }), null);
});

test("preview subscription drops stale frames and never overlaps captures", async () => {
  const pending: ((value: number) => void)[] = [];
  const frames: number[] = [];
  const stream = new PreviewStream(
    () => new Promise<number>((resolve) => pending.push(resolve)),
    (frame) => frames.push(frame),
  );
  stream.setFps(30);
  stream.setSubscribed(true);
  stream.setSubscribed(true);
  assert.equal(pending.length, 1);
  stream.setSubscribed(false);
  stream.setSubscribed(true);
  assert.equal(pending.length, 1);
  pending[0](1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(frames, []);
  assert.equal(pending.length, 2);
  pending[1](2);
  await Promise.resolve();
  assert.deepEqual(frames, [2]);
  stream.dispose();
  stream.setSubscribed(true);
  assert.equal(pending.length, 2);
});

test("native crash capture stays local and records GPU exit codes and stacks", () => {
  let options: any;
  const extra: Record<string, string> = {};
  const reporter = {
    start(value: unknown) {
      options = value;
    },
    addExtraParameter(key: string, value: string) {
      extra[key] = value;
    },
  };
  startNativeCrashes(reporter, "Claudex", "1.2.3");
  assert.equal(options.uploadToServer, false);
  assert.equal(options.compress, true);
  assert.equal(options.ignoreSystemCrashHandler, true);
  assert.equal(options.globalExtra.release, "Claudex@1.2.3");
  recordGpuExit(
    reporter,
    { type: "GPU", reason: "crashed", exitCode: 4294967295 },
    new Date(0),
  );
  assert.equal(extra.gpu_last_exit_code, "-1");
  assert.equal(extra.gpu_last_exit_code_hex, "0xFFFFFFFF");
  assert.equal(extra.gpu_last_exit_at, new Date(0).toISOString());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-crashes-"));
  try {
    keepCrashStack(root, new Error("native parity test"));
    assert.match(
      fs.readFileSync(path.join(root, "exceptions.log"), "utf8"),
      /Error: native parity test\n\s+at/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("account memory edits existing files, reserves the index, rejects symlinks and resets separately", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-memory-files-"));
  try {
    const store = new CoworkMemoryFiles(root);
    assert.equal(store.write("missing.md", "no"), false);
    assert.equal(store.save("facts.md", "Likes tea"), true);
    assert.equal(store.save("MEMORY.md", "index"), false);
    assert.equal(store.write("facts.md", "Likes coffee"), true);
    assert.equal(store.read("facts.md")?.content, "Likes coffee");
    fs.writeFileSync(path.join(root, "global.md"), "global instructions");
    fs.symlinkSync(
      path.join(root, "global.md"),
      path.join(store.directory, "link.md"),
    );
    assert.equal(store.read("link.md"), null);
    assert.deepEqual(
      store.list(false).map((file) => [file.path, file.content]),
      [["facts.md", undefined]],
    );
    assert.match(store.instructions(), /Likes coffee/);
    assert.equal(store.reset(), true);
    assert.deepEqual(store.list(), []);
    assert.equal(
      fs.readFileSync(path.join(root, "global.md"), "utf8"),
      "global instructions",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("project memory is isolated from the account and other projects", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-memory-spaces-"));
  try {
    const account = new CoworkMemoryFiles(root);
    const project = new CoworkMemoryFiles(root, "project-one");
    const other = new CoworkMemoryFiles(root, "project-two");
    assert.equal(project.save("facts.md", "Project preference"), true);
    assert.equal(account.read("facts.md"), null);
    assert.equal(other.read("facts.md"), null);
    assert.match(project.instructions(), /Project preference/);
    assert.equal(project.reset(), true);
    assert.equal(project.read("facts.md"), null);
    assert.throws(() => new CoworkMemoryFiles(root, "../escape"));
    fs.rmSync(path.join(root, "cowork-memory-spaces"), { recursive: true });
    fs.mkdirSync(path.join(root, "elsewhere"));
    fs.symlinkSync(
      path.join(root, "elsewhere"),
      path.join(root, "cowork-memory-spaces"),
    );
    assert.equal(project.save("facts.md", "must not escape"), false);
    assert.equal(project.reset(), false);
    assert.deepEqual(project.list(), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("PR review checks are bound to the PR before annotations or reruns", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const endpoint = args[1];
    const value = endpoint.endsWith("/pulls/3")
      ? { head: { sha: "a".repeat(40) } }
      : endpoint.includes("/commits/")
        ? [{ check_runs: [{ id: 12 }] }]
        : endpoint.includes("annotations")
          ? [[{ path: "src/a.ts", start_line: 1, message: "bad" }]]
          : {};
    return { code: 0, stdout: JSON.stringify(value), stderr: "" };
  };
  const request = { repository: "octo/repo", number: 3 };
  const result = await githubReview(
    { ...request, action: "annotations", checkRunId: 12 },
    run,
  );
  assert.equal(result.annotations?.[0].path, "src/a.ts");
  await assert.rejects(
    githubReview({ ...request, action: "rerun", checkRunId: 13 }, run),
    /not part/,
  );
  assert.equal(
    calls.some((args) => args[1].endsWith("/13/rerequest")),
    false,
  );
  await githubReview(
    {
      ...request,
      action: "comment",
      commitSha: "a".repeat(40),
      path: "src/a.ts",
      line: 3,
      startLine: 2,
      side: "LEFT",
      body: "change this",
    },
    run,
  );
  assert.ok(calls.at(-1)?.includes("start_line=2"));
  assert.ok(calls.at(-1)?.includes("start_side=LEFT"));
  assert.equal(
    githubReviewInput.safeParse({
      ...request,
      action: "review",
      event: "REQUEST_CHANGES",
    }).success,
    false,
  );
  assert.equal(
    githubReviewInput.safeParse({
      ...request,
      action: "review",
      event: "APPROVE",
    }).success,
    true,
  );
});

test("review thread mutations reject IDs belonging to another PR", async () => {
  let mutated = false;
  const run = async (args: string[]) => {
    const query = args.find((value) => value.startsWith("query=")) ?? "";
    if (query.includes("mutation")) mutated = true;
    return {
      code: 0,
      stdout: JSON.stringify({
        data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
      }),
      stderr: "",
    };
  };
  await assert.rejects(
    githubReview(
      {
        repository: "octo/repo",
        number: 3,
        action: "resolve",
        threadId: "PRRT_other",
      },
      run,
    ),
  );
  assert.equal(mutated, false);
});
