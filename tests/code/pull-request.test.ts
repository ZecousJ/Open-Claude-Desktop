import test from "node:test";
import assert from "node:assert/strict";
import {
  commitPrompt,
  compareUrl,
  createPrPrompt,
  parsePullRequestUrl,
  pullRequestsIn,
  sessionPullRequest,
  sessionPullRequests,
  usableBaseBranch,
} from "../../shared/pull-request";
import { displayPrompt } from "../../shared/pr-display";
import { withoutPrTags } from "../../shared/pr-tags";
import type { Conversation } from "../../shared/types";

const target = {
  repository: "octo/hello",
  branch: "feature/x",
  baseBranch: "main",
  cwd: "/work/hello",
};

test("Create PR's message wraps its steps, names the target and asks for the address in a tag", () => {
  const prompt = createPrPrompt(target);
  assert.ok(prompt.startsWith("<create-pr-command>\n"));
  assert.ok(prompt.endsWith("\n</create-pr-command>"));
  assert.match(prompt, /ready for review \(not a draft\)/);
  assert.match(prompt, /Do not pass `--draft`/);
  assert.match(
    prompt,
    /<pr-created>https:\/\/github\.com\/owner\/repo\/pull\/123/,
  );
  assert.match(
    prompt,
    /Repository: octo\/hello\nBranch: feature\/x\nBase branch: main\nWorking directory: \/work\/hello$/m,
  );
  assert.match(prompt, /If a PR already exists for this branch/);
});

test("Create draft PR keeps --draft, and a cloud session uses its GitHub tools instead of git and gh", () => {
  const draft = createPrPrompt({ ...target, draft: true });
  assert.match(draft, /as a draft/);
  assert.match(draft, /`gh pr create --draft`/);
  const cloud = createPrPrompt({ ...target, cloud: true });
  assert.match(cloud, /github push tool/);
  assert.match(cloud, /github create_pull_request tool, with `draft` false/);
  assert.doesNotMatch(cloud, /gh pr create|Working directory/);
  assert.match(
    createPrPrompt({ ...target, cloud: true, draft: true }),
    /`draft` true/,
  );
});

test("a base branch is named only when it is another, plainly named branch", () => {
  assert.equal(usableBaseBranch({ branch: "a", baseBranch: "main" }), "main");
  assert.equal(
    usableBaseBranch({ branch: "main", baseBranch: "main" }),
    undefined,
  );
  assert.equal(
    usableBaseBranch({ branch: "a", baseBranch: "--evil x" }),
    undefined,
  );
  assert.doesNotMatch(
    createPrPrompt({ ...target, branch: "main", baseBranch: "main" }),
    /Base branch/,
  );
  assert.doesNotMatch(
    createPrPrompt({ branch: "x", cwd: undefined }),
    /Repository:|Working directory/,
  );
});

test("the transcript shows Create PR's message as /create-pr", () => {
  assert.equal(displayPrompt(createPrPrompt(target)), "/create-pr");
  assert.equal(
    displayPrompt(createPrPrompt({ ...target, draft: true })),
    "/create-pr --draft",
  );
  assert.equal(
    displayPrompt(createPrPrompt({ ...target, cloud: true })),
    "/create-pr",
  );
  assert.equal(
    displayPrompt(createPrPrompt({ ...target, cloud: true, draft: true })),
    "/create-pr --draft",
  );
  // Anything else, including a message that only mentions the tag, is left alone.
  assert.equal(displayPrompt("fix the bug"), "fix the bug");
  assert.equal(displayPrompt(commitPrompt), commitPrompt);
  const mixed = `hello ${createPrPrompt(target)}`;
  assert.equal(displayPrompt(mixed), mixed);
});

test("a <pr-created> tag reads as its link, also while it is still being written", () => {
  assert.equal(
    withoutPrTags(
      "Done.\n<pr-created>https://github.com/o/r/pull/7</pr-created>\nBye",
    ),
    "Done.\nhttps://github.com/o/r/pull/7\nBye",
  );
  assert.equal(
    withoutPrTags("Done.\n<pr-created>https://github.com/o/r/pu"),
    "Done.",
  );
  assert.equal(withoutPrTags("no tag <b>here</b>"), "no tag <b>here</b>");
  // A word right after the link keeps a space so the link does not swallow it.
  assert.equal(
    withoutPrTags("<pr-created>https://github.com/o/r/pull/7</pr-created>x"),
    "https://github.com/o/r/pull/7 x",
  );
});

test("pull request addresses are parsed, and tagged ones come before bare links", () => {
  assert.deepEqual(parsePullRequestUrl("https://github.com/o/r/pull/7"), {
    url: "https://github.com/o/r/pull/7",
    host: "github.com",
    repository: "o/r",
    number: 7,
  });
  assert.equal(
    parsePullRequestUrl("https://github.com/o/r/issues/7"),
    undefined,
  );
  assert.equal(
    parsePullRequestUrl("https://ghe.example.com/o/r/pull/9")?.host,
    "ghe.example.com",
  );
  assert.deepEqual(
    pullRequestsIn(
      "see https://github.com/a/b/pull/1 and <pr-created>https://github.com/o/r/pull/7</pr-created>",
    ).map((ref) => ref.number),
    [7],
  );
  assert.deepEqual(
    pullRequestsIn(
      "https://github.com/a/b/pull/1 https://github.com/a/b/pull/1 https://github.com/a/b/pull/2/files",
    ).map((ref) => ref.number),
    [1],
  );
});

test("the session's pull request is the last one Claude tagged", () => {
  const conversation = (texts: string[][]) =>
    ({
      turns: texts.map((items, index) => ({
        id: `t${index}`,
        prompt: "",
        attachments: [],
        status: "completed",
        createdAt: index,
        items: items.map((text, i) => ({
          id: `i${index}-${i}`,
          type: "agentMessage",
          text,
        })),
      })),
    }) as unknown as Conversation;
  assert.equal(sessionPullRequest(conversation([["no pr"]])), undefined);
  // A plain link is not the session's own pull request.
  assert.equal(
    sessionPullRequest(
      conversation([["compare https://github.com/a/b/pull/3"]]),
    ),
    undefined,
  );
  assert.equal(
    sessionPullRequest(
      conversation([
        ["<pr-created>https://github.com/o/r/pull/7</pr-created>"],
        ["x"],
        ["<pr-created>https://github.com/o/r/pull/9</pr-created>"],
      ]),
    )?.number,
    9,
  );
});

test("Manually create PR opens GitHub's compare page for the branch", () => {
  assert.equal(
    compareUrl({
      repository: "octo/hello",
      branch: "feature/x y",
      baseBranch: "main",
    }),
    "https://github.com/octo/hello/compare/main...feature/x%20y?expand=1",
  );
  assert.equal(
    compareUrl({ repository: "octo/hello", branch: "feature" }),
    "https://github.com/octo/hello/compare/feature?expand=1",
  );
  assert.equal(compareUrl({ repository: "nope", branch: "x" }), undefined);
});

test("every pull request the session tagged, newest first, each once", () => {
  const turn = (index: number, text: string) => ({
    id: `t${index}`,
    prompt: "",
    attachments: [],
    status: "completed",
    createdAt: index,
    items: [{ id: `i${index}`, type: "agentMessage", text }],
  });
  const conversation = {
    turns: [
      turn(0, "<pr-created>https://github.com/a/b/pull/1</pr-created>"),
      turn(
        1,
        "<pr-created>https://github.com/a/b/pull/2</pr-created> see https://github.com/a/b/pull/9",
      ),
      turn(2, "<pr-created>https://github.com/A/B/pull/1</pr-created>"),
    ],
  } as unknown as Conversation;
  assert.deepEqual(
    sessionPullRequests(conversation).map((ref) => ref.number),
    [1, 2],
  );
});
