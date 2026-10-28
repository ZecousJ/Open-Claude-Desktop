import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseCloneGrant,
  pinnedRef,
  withGitHubClone,
  type GitRun,
} from "../../runner/src/github-workspace";
import { parseRepository } from "../../runner/src/code-workspace";

const TOKEN = "gho_SECRET_token_value";
const grantAnswer = (over: Record<string, unknown> = {}) => ({
  url: "https://github.com/octo/hello.git",
  username: "x-access-token",
  token: TOKEN,
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  repository: "octo/hello",
  defaultBranch: "main",
  canPush: true,
  ...over,
});

function harness(
  over: { answer?: unknown; exit?: number; stderr?: string } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gh-ws-test-"));
  const requests: unknown[][] = [];
  const runs: GitRun[] = [];
  const seen: { helper?: string; helperText?: string } = {};
  const hook = withGitHubClone({
    transport: {
      request: async (op, userId, body) => {
        requests.push([op, userId, body]);
        return "answer" in over ? over.answer : grantAnswer();
      },
    },
    base: async (session: { userId: number; id: string }) => {
      const cwd = path.join(root, "code", session.id);
      fs.mkdirSync(cwd, { recursive: true });
      return { cwd };
    },
    runGit: async (run) => {
      runs.push(run);
      if (run.env.GIT_ASKPASS) {
        seen.helper = run.env.GIT_ASKPASS;
        seen.helperText = fs.readFileSync(run.env.GIT_ASKPASS, "utf8");
      }
      return { code: over.exit ?? 0, stderr: over.stderr ?? "" };
    },
  });
  return { hook, root, requests, runs, seen };
}

test("without a repository the session gets its empty folder and nothing is asked", async () => {
  const h = harness();
  const { cwd } = await h.hook({ userId: 7, id: "s1" });
  assert.equal(cwd, path.join(h.root, "code", "s1"));
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.runs, []);
});

test("a repository is cloned with a leased credential that never reaches argv or the folder", async () => {
  const h = harness();
  const { cwd } = await h.hook(
    { userId: 7, id: "s1" },
    { url: "https://github.com/octo/hello", ref: "feature/x" },
  );
  assert.deepEqual(h.requests, [
    [
      "github.clone",
      7,
      { url: "https://github.com/octo/hello", ref: "feature/x" },
    ],
  ]);
  const run = h.runs[0]!;
  assert.deepEqual(run.argv, [
    "-c",
    "credential.helper=",
    "clone",
    "--quiet",
    "--branch",
    "feature/x",
    "--",
    "https://github.com/octo/hello.git",
    cwd,
  ]);
  assert.ok(!run.argv.join(" ").includes(TOKEN), "the token is not in argv");
  assert.equal(run.env.CLAUDEX_GIT_TOKEN, TOKEN);
  assert.equal(run.env.GIT_TERMINAL_PROMPT, "0");
  // The helper prints the credential from the environment, not from a file.
  assert.ok(!h.seen.helperText!.includes(TOKEN));
  // Its private folder is gone afterwards, and the session folder is clean.
  assert.equal(fs.existsSync(path.dirname(h.seen.helper!)), false);
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test("a ref clone can't check out is fetched after it, on the branch it names", async () => {
  const h = harness();
  const ref = "refs/claudex-continue/0123456789abcdef";
  const { cwd } = await h.hook(
    { userId: 7, id: "s1" },
    { url: "https://github.com/octo/hello", ref, branch: "feature/x" },
  );
  assert.equal(pinnedRef(ref), true);
  assert.equal(pinnedRef("feature/x"), false);
  assert.equal(pinnedRef("refs/heads/main"), false);
  assert.equal(pinnedRef("a".repeat(40)), true);
  assert.deepEqual(
    h.runs.map((run) => run.argv),
    [
      [
        "-c",
        "credential.helper=",
        "clone",
        "--quiet",
        "--no-checkout",
        "--",
        "https://github.com/octo/hello.git",
        cwd,
      ],
      [
        "-C",
        cwd,
        "-c",
        "credential.helper=",
        "fetch",
        "--quiet",
        "--no-tags",
        "origin",
        ref,
      ],
      ["-C", cwd, "checkout", "--quiet", "-B", "feature/x", "FETCH_HEAD"],
    ],
  );
  // The checkout needs no credential.
  assert.equal(h.runs[2]!.env.CLAUDEX_GIT_TOKEN, undefined);
  assert.deepEqual(
    parseRepository({
      url: "https://github.com/octo/hello",
      ref,
      branch: "feature/x",
    }),
    { url: "https://github.com/octo/hello", ref, branch: "feature/x" },
  );
  assert.throws(() =>
    parseRepository({ url: "https://github.com/octo/hello", branch: "x" }),
  );
});

test("a failed clone says why without the token, and still cleans up", async () => {
  const h = harness({
    exit: 128,
    stderr: `fatal: Authentication failed for 'https://x-access-token:${TOKEN}@github.com/octo/hello.git'`,
  });
  await assert.rejects(
    h.hook({ userId: 7, id: "s1" }, { url: "https://github.com/octo/hello" }),
    (error: Error) => {
      assert.match(
        error.message,
        /Couldn't clone octo\/hello: fatal: Authentication failed/,
      );
      assert.ok(!error.message.includes(TOKEN));
      return true;
    },
  );
  assert.equal(fs.existsSync(path.dirname(h.seen.helper!)), false);
  // The session never started: its new folder is gone too.
  assert.equal(fs.existsSync(path.join(h.root, "code", "s1")), false);
});

test("the service's refusal reaches the person and nothing is cloned", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gh-ws-test-"));
  let ran = false;
  const hook = withGitHubClone({
    transport: {
      request: async () => {
        throw new Error("Connect your GitHub account first");
      },
    },
    base: async () => ({ cwd: root }),
    runGit: async () => {
      ran = true;
      return { code: 0, stderr: "" };
    },
  });
  await assert.rejects(
    hook({ userId: 7 }, { url: "https://github.com/octo/hello" }),
    /Connect your GitHub account first/,
  );
  assert.equal(ran, false);
});

test("an expired lease is never used", async () => {
  const h = harness({
    answer: grantAnswer({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }),
  });
  await assert.rejects(
    h.hook({ userId: 7, id: "s1" }, { url: "https://github.com/octo/hello" }),
    /expired/,
  );
  assert.deepEqual(h.runs, []);
});

test("only a well-formed grant without credentials in its address is accepted", () => {
  assert.equal(parseCloneGrant(grantAnswer()).token, TOKEN);
  for (const bad of [
    null,
    grantAnswer({ url: "http://github.com/o/r.git" }),
    grantAnswer({ url: `https://x:${TOKEN}@github.com/o/r.git` }),
    grantAnswer({ token: "" }),
    grantAnswer({ expiresAt: "soon" }),
  ])
    assert.throws(() => parseCloneGrant(bad));
});

test("a session with several repositories clones the others inside the main checkout", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gh-ws-multi-"));
  const requests: unknown[] = [];
  const targets: string[] = [];
  const hook = withGitHubClone({
    transport: {
      request: async (_op, _userId, body) => {
        requests.push(body);
        const name = (body as { url: string }).url.replace(
          /^https:\/\/github\.com\//,
          "",
        );
        return grantAnswer({
          url: `https://github.com/${name}.git`,
          repository: name,
        });
      },
    },
    base: async (session: { userId: number; id: string }) => {
      const cwd = path.join(root, "code", session.id);
      fs.mkdirSync(cwd, { recursive: true });
      return { cwd };
    },
    // A clone makes its folder; the main checkout holds a folder named
    // like one of the others.
    runGit: async (run) => {
      const target = run.argv.at(-1)!;
      targets.push(target);
      fs.mkdirSync(path.join(target, ".git"), { recursive: true });
      if (targets.length === 1) fs.mkdirSync(path.join(target, "tool"));
      return { code: 0, stderr: "" };
    },
  });
  const { cwd } = await hook(
    { userId: 7, id: "s2" },
    { url: "https://github.com/octo/hello" },
    [
      { url: "https://github.com/acme/tool", ref: "dev" },
      { url: "https://github.com/acme/lib" },
      { url: "https://github.com/other/lib" },
    ],
  );
  assert.equal(requests.length, 4);
  assert.deepEqual(requests[1], {
    url: "https://github.com/acme/tool",
    ref: "dev",
  });
  assert.deepEqual(targets, [
    cwd,
    // "tool" is taken in the main checkout; two "lib"s take their owner.
    path.join(cwd, "tool-2"),
    path.join(cwd, "acme-lib"),
    path.join(cwd, "other-lib"),
  ]);
  // The main checkout's own status leaves them out.
  const exclude = fs.readFileSync(
    path.join(cwd, ".git", "info", "exclude"),
    "utf8",
  );
  assert.match(exclude, /^\/tool-2\/$/m);
  assert.match(exclude, /^\/acme-lib\/$/m);
  assert.match(exclude, /^\/other-lib\/$/m);
});

test("when another repository fails to clone, the whole session folder goes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gh-ws-multi-fail-"));
  let runs = 0;
  const hook = withGitHubClone({
    transport: { request: async () => grantAnswer() },
    base: async (session: { userId: number; id: string }) => {
      const cwd = path.join(root, "code", session.id);
      fs.mkdirSync(cwd, { recursive: true });
      return { cwd };
    },
    runGit: async () =>
      ++runs === 1
        ? { code: 0, stderr: "" }
        : { code: 128, stderr: `fatal: could not read ${TOKEN}` },
  });
  await assert.rejects(
    hook({ userId: 7, id: "s3" }, { url: "https://github.com/octo/hello" }, [
      { url: "https://github.com/acme/tool" },
    ]),
    (error: Error) =>
      /Couldn't clone/.test(error.message) && !error.message.includes(TOKEN),
  );
  assert.equal(fs.existsSync(path.join(root, "code", "s3")), false);
});
