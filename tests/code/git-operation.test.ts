import assert from "node:assert/strict";
import test from "node:test";
import {
  gitOperationOf,
  gitOperationVerb,
  scriptOperations,
  shellCommands,
  shellScript,
} from "../../shared/git-operation";
import type { Item } from "../../shared/types";

const bash = (
  command: string,
  output = "",
  extra: Partial<Item> = {},
): Item => ({
  id: "i",
  type: "commandExecution",
  command,
  aggregatedOutput: output,
  exitCode: 0,
  lifecycleStatus: "completed",
  status: "completed",
  ...extra,
});

const github = (
  tool: string,
  result: unknown,
  args: object = {},
  extra: Partial<Item> = {},
): Item => ({
  id: "g",
  type: "dynamicToolCall",
  namespace: "github",
  tool,
  arguments: args,
  contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
  success: true,
  lifecycleStatus: "completed",
  ...extra,
});

test("shell words keep quotes together and split commands at operators", () => {
  assert.deepEqual(
    shellCommands(`git add -A && git commit -m "fix: a && b; c" || echo 'x y'`),
    [
      ["git", "add", "-A"],
      ["git", "commit", "-m", "fix: a && b; c"],
      ["echo", "x y"],
    ],
  );
  // A heredoc body is text, whatever it says.
  assert.deepEqual(
    shellCommands(
      `git commit -F - <<'EOF'\ngit push origin main\nsecond line\nEOF\necho done`,
    ),
    [
      ["git", "commit", "-F", "-"],
      ["echo", "done"],
    ],
  );
  // A message built with a substitution, quotes and a heredoc inside.
  const message = `git commit -m "$(cat <<'EOF'\nA "quoted" (thing)\nEOF\n)" && git push origin feature`;
  assert.deepEqual(shellCommands(message), [
    ["git", "commit", "-m", `$(cat <<'EOF'\nA "quoted" (thing)\nEOF\n)`],
    ["git", "push", "origin", "feature"],
  ]);
  assert.deepEqual(shellCommands("echo a # git push origin x\nls"), [
    ["echo", "a"],
    ["ls"],
  ]);
});

test("a login shell's script is unwrapped", () => {
  assert.equal(
    shellScript(`/bin/zsh -lc "git status && ls"`),
    "git status && ls",
  );
  assert.equal(shellScript(`bash -c 'echo "a b"'`), `echo "a b"`);
  assert.equal(shellScript("git status"), "git status");
});

test("a commit reads its hash from git's own report", () => {
  const out = "[feature 1a2b3c4] Fix login\n 1 file changed, 2 insertions(+)\n";
  assert.deepEqual(gitOperationOf(bash(`git commit -m "Fix login"`, out)), {
    kind: "commit",
    commitKind: "committed",
    meta: "1a2b3c4",
  });
  assert.deepEqual(
    gitOperationOf(bash(`bash -lc "git commit --amend --no-edit"`, out)),
    { kind: "commit", commitKind: "amended", meta: "1a2b3c4" },
  );
  assert.equal(
    gitOperationOf(
      bash("git commit -m x", "[main (root-commit) 9f8e7d6a5b4c] x\n"),
    )?.meta,
    "9f8e7d6",
  );
  assert.deepEqual(gitOperationOf(bash("git cherry-pick abc1234", out)), {
    kind: "commit",
    commitKind: "cherry-picked",
    meta: "1a2b3c4",
  });
  // Global options before the subcommand, and an env prefix.
  assert.equal(
    gitOperationOf(
      bash(`GIT_AUTHOR_NAME=a git -C sub -c user.name=x commit -m y`, out),
    )?.kind,
    "commit",
  );
  // No hash reported: nothing to say.
  assert.equal(
    gitOperationOf(bash("git commit -m x", "nothing to commit")),
    undefined,
  );
  assert.equal(gitOperationOf(bash("git commit --dry-run", out)), undefined);
});

test("text inside a message or heredoc is never an operation", () => {
  assert.equal(
    gitOperationOf(bash(`echo "git commit -m x" && ls`, "[a 1a2b3c4] x")),
    undefined,
  );
  assert.equal(
    gitOperationOf(
      bash(`cat > notes.md <<'EOF'\ngit push origin main\nEOF`, ""),
    ),
    undefined,
  );
  assert.equal(
    gitOperationOf(bash(`grep "git rebase main" log.txt`, "")),
    undefined,
  );
});

test("a command that failed, was stopped or still runs is no operation", () => {
  const out = "[feature 1a2b3c4] Fix\n";
  assert.equal(
    gitOperationOf(bash("git commit -m x", out, { exitCode: 1 })),
    undefined,
  );
  assert.equal(
    gitOperationOf(
      bash("git commit -m x", out, { lifecycleStatus: "inProgress" }),
    ),
    undefined,
  );
  assert.equal(
    gitOperationOf(
      bash("git commit -m x", out, { lifecycleStatus: "interrupted" }),
    ),
    undefined,
  );
  assert.equal(
    gitOperationOf(bash("git commit -m x", out, { status: "declined" })),
    undefined,
  );
});

test("push, rebase and merge name the branch", () => {
  assert.deepEqual(gitOperationOf(bash("git push -u origin feature/login")), {
    kind: "push",
    meta: "feature/login",
  });
  assert.deepEqual(
    gitOperationOf(bash("git push origin HEAD:refs/heads/topic")),
    {
      kind: "push",
      meta: "topic",
    },
  );
  assert.deepEqual(
    gitOperationOf(bash("git push --force-with-lease origin +fix")),
    {
      kind: "push",
      meta: "fix",
    },
  );
  // No branch is named, or nothing is sent.
  assert.equal(gitOperationOf(bash("git push")), undefined);
  assert.equal(gitOperationOf(bash("git push origin")), undefined);
  assert.equal(gitOperationOf(bash("git push origin HEAD")), undefined);
  assert.equal(gitOperationOf(bash("git push --delete origin old")), undefined);
  assert.equal(gitOperationOf(bash("git push -n origin main")), undefined);

  assert.deepEqual(
    gitOperationOf(bash("git fetch && git rebase origin/main")),
    {
      kind: "branch",
      action: "rebased",
      meta: "origin/main",
    },
  );
  assert.deepEqual(
    gitOperationOf(bash("git rebase --onto develop main topic")),
    {
      kind: "branch",
      action: "rebased",
      meta: "develop",
    },
  );
  assert.equal(gitOperationOf(bash("git rebase --continue")), undefined);
  assert.equal(gitOperationOf(bash("git rebase --abort")), undefined);
  assert.deepEqual(
    gitOperationOf(
      bash(
        "git merge --no-ff -m 'merge it' origin/main",
        "Merge made by the 'ort' strategy.",
      ),
    ),
    {
      kind: "branch",
      action: "merged",
      meta: "origin/main",
    },
  );
  assert.equal(
    gitOperationOf(bash("git merge origin/main", "Already up to date.")),
    undefined,
  );
});

test("a pull request takes its number from gh's report", () => {
  assert.deepEqual(
    gitOperationOf(
      bash(
        `gh pr create --title "Fix" --body "b" --base main`,
        "https://github.com/octo/repo/pull/12\n",
      ),
    ),
    {
      kind: "pr",
      action: "created",
      meta: "#12",
      url: "https://github.com/octo/repo/pull/12",
    },
  );
  assert.equal(
    gitOperationOf(
      bash(
        "gh pr merge 7 --squash",
        "✓ Squashed and merged pull request #7 (Fix)\n",
      ),
    )?.meta,
    "#7",
  );
  assert.equal(gitOperationOf(bash("gh pr comment 7 -b hi", ""))?.meta, "#7");
  assert.equal(
    (gitOperationOf(bash("gh pr close 3", "✓ Closed pull request #3\n")) as any)
      ?.action,
    "closed",
  );
  assert.equal(
    (gitOperationOf(bash("gh pr ready 4", "")) as any)?.action,
    "ready",
  );
  assert.equal(gitOperationOf(bash("gh pr ready 4 --undo", "")), undefined);
  assert.equal(gitOperationOf(bash("gh pr view 4", "")), undefined);
  // No number anywhere: nothing to say.
  assert.equal(gitOperationOf(bash("gh pr create --fill", "")), undefined);
});

test("one command with several operations shows the most important one", () => {
  const out = "[feature 1a2b3c4] Fix\n";
  // A pull request wins over a push, a push over a commit.
  assert.deepEqual(
    gitOperationOf(
      bash("git add -A && git commit -m x && git push -u origin feature", out),
    ),
    { kind: "push", meta: "feature" },
  );
  assert.equal(
    gitOperationOf(
      bash(
        "git commit -m x && git push origin feature && gh pr create --fill",
        out + "https://github.com/a/b/pull/5\n",
      ),
    )?.kind,
    "pr",
  );
  assert.equal(scriptOperations("git add -A && git status", "").length, 0);
});

test("GitHub tool calls of a cloud session give the same rows", () => {
  assert.deepEqual(
    gitOperationOf(
      github("create_pull_request", {
        number: 12,
        html_url: "https://github.com/octo/repo/pull/12",
      }),
    ),
    {
      kind: "pr",
      action: "created",
      meta: "#12",
      url: "https://github.com/octo/repo/pull/12",
    },
  );
  assert.deepEqual(
    gitOperationOf(
      github("push", {
        pushed: "feature → octo/repo:feature",
        branch: "feature",
        branch_url: "https://github.com/octo/repo/tree/feature",
      }),
    ),
    { kind: "push", meta: "feature" },
  );
  // An older result without `branch`: the address names it.
  assert.equal(
    (
      gitOperationOf(
        github("push", {
          pushed: "a → octo/repo:fix%2Fone",
          branch_url: "https://github.com/octo/repo/tree/fix/one",
        }),
      ) as any
    )?.meta,
    "fix/one",
  );
  assert.deepEqual(
    gitOperationOf(
      github("comment", {
        number: 1,
        html_url: "https://github.com/octo/repo/pull/12#issuecomment-5",
      }),
    ),
    { kind: "pr", action: "commented", meta: "#12" },
  );
  // A comment on an issue, a failed call and another namespace say nothing.
  assert.equal(
    gitOperationOf(
      github("comment", {
        html_url: "https://github.com/octo/repo/issues/3#issuecomment-1",
      }),
    ),
    undefined,
  );
  assert.equal(
    gitOperationOf(
      github("create_pull_request", { number: 1 }, {}, { success: false }),
    ),
    undefined,
  );
  assert.equal(
    gitOperationOf(
      github("create_pull_request", { number: 1 }, {}, { namespace: "other" }),
    ),
    undefined,
  );
  assert.equal(
    gitOperationOf(
      github(
        "create_pull_request",
        { number: 1 },
        {},
        { lifecycleStatus: "inProgress" },
      ),
    ),
    undefined,
  );
  assert.equal(
    gitOperationOf(github("create_issue", { number: 1 })),
    undefined,
  );
});

test("the verbs are the official ccr words", () => {
  const verbs = [
    [{ kind: "pr", action: "created", meta: "#1" }, "Created PR"],
    [{ kind: "pr", action: "edited", meta: "#1" }, "Edited PR"],
    [{ kind: "pr", action: "merged", meta: "#1" }, "Merged PR"],
    [{ kind: "pr", action: "commented", meta: "#1" }, "Commented on PR"],
    [{ kind: "pr", action: "closed", meta: "#1" }, "Closed PR"],
    [{ kind: "pr", action: "ready", meta: "#1" }, "Marked ready PR"],
    [{ kind: "push", meta: "x" }, "Pushed to"],
    [{ kind: "branch", action: "merged", meta: "x" }, "Merged"],
    [{ kind: "branch", action: "rebased", meta: "x" }, "Rebased onto"],
    [{ kind: "commit", commitKind: "committed", meta: "x" }, "Committed"],
    [{ kind: "commit", commitKind: "amended", meta: "x" }, "Amended commit"],
    [
      { kind: "commit", commitKind: "cherry-picked", meta: "x" },
      "Cherry-picked",
    ],
  ] as const;
  for (const [operation, verb] of verbs)
    assert.equal(gitOperationVerb(operation as any), verb);
});
