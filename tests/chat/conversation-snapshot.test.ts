import test from "node:test";
import assert from "node:assert/strict";
import {
  activitySummary,
  buildArtifactSnapshot,
  buildConversationSnapshot,
  redactHomeFolders,
  secretFileName,
  snapshotBytes,
} from "../../electron/conversations/conversation-snapshot";
import { snapshotLanguage } from "../../shared/sharing";
import type { Conversation, GeneratedFile, Turn } from "../../shared/types";

const limits = {
  maxArtifactBytes: 2 * 1024 * 1024,
  maxSnapshotBytes: 8 * 1024 * 1024,
};

function file(overrides: Partial<GeneratedFile>): GeneratedFile {
  return {
    id: "f",
    name: "page.html",
    path: "/Users/bob/site/page.html",
    language: "html",
    operation: "create",
    state: "ready",
    content: "<p>v1</p>",
    ...overrides,
  };
}
function turn(id: string, overrides: Partial<Turn> = {}): Turn {
  return {
    id,
    prompt: `Prompt ${id}`,
    attachments: [],
    items: [{ id: `${id}-a`, type: "agentMessage", text: `Reply ${id}` }],
    status: "completed",
    createdAt: 1,
    ...overrides,
  };
}
function conversation(turns: Turn[], extra: Partial<Conversation> = {}) {
  return {
    id: "c-1",
    title: "  Build a   site  ",
    mode: "code",
    cwd: "/Users/bob/site",
    providerId: "sub2api",
    model: "gpt-test",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns,
    ...extra,
  } satisfies Conversation;
}

test("a snapshot keeps prompts and reply text, and nothing else", () => {
  const snapshot = buildConversationSnapshot(
    conversation(
      [
        turn("t-1", {
          prompt: "Fix C:\\Users\\Bob\\site\\a.ts please",
          attachments: [
            {
              id: "a",
              name: "id.png",
              path: "/Users/bob/id.png",
              kind: "image",
              size: 9,
            },
          ],
          items: [
            { id: "r", type: "reasoning", summary: ["secret thinking"] },
            {
              id: "c",
              type: "commandExecution",
              command: "cat ~/.ssh/id_rsa",
              aggregatedOutput: "PRIVATE KEY",
              cwd: "/Users/bob/site",
            },
            { id: "c2", type: "commandExecution", command: "ls" },
            {
              id: "m",
              type: "mcpToolCall",
              server: "db",
              result: { rows: ["customer"] },
            },
            {
              id: "e",
              type: "fileChange",
              changes: [
                {
                  path: "/Users/bob/site/a.ts",
                  kind: "update",
                  diff: "+token",
                },
                { path: "/Users/bob/site/b.ts", kind: "update", diff: "+x" },
              ],
            },
            { id: "w", type: "webSearch", query: "private query" },
            { id: "x", type: "agentMessage", text: "Done in /Users/bob/site." },
            { id: "y", type: "agentMessage", text: "Second part." },
          ],
        }),
        turn("t-2", { status: "inProgress", prompt: "still running" }),
      ],
      {},
    ),
    limits,
  );
  assert.deepEqual(snapshot, {
    kind: "conversation",
    title: "Build a site",
    mode: "code",
    messages: [
      { role: "user", text: "Fix ~\\site\\a.ts please" },
      {
        role: "assistant",
        text: "Done in ~/site.\n\nSecond part.",
        activity: [
          "Ran 2 commands",
          "Edited 2 files",
          "Searched the web",
          "Used a tool",
        ],
      },
    ],
  });
  const json = JSON.stringify(snapshot);
  for (const leaked of [
    "secret thinking",
    "id_rsa",
    "PRIVATE KEY",
    "customer",
    "+token",
    "private query",
    "id.png",
    "still running",
    "bob",
    "gpt-test",
  ])
    assert.ok(!json.includes(leaked), leaked);
});

test("files the replies wrote become artifacts under the reply that wrote them last", () => {
  const snapshot = buildConversationSnapshot(
    conversation([
      turn("t-1", {
        items: [
          { id: "a", type: "agentMessage", text: "Made a page." },
          {
            id: "g",
            type: "fileChange",
            generatedFiles: [
              file({}),
              file({
                id: "img",
                name: "a.png",
                path: "/w/a.png",
                blob: true,
                content: undefined,
              }),
              file({
                id: "notes",
                name: "notes.md",
                path: "/w/notes.md",
                language: "markdown",
                content: "# Notes",
              }),
            ],
          },
        ],
      }),
      turn("t-2", {
        items: [
          { id: "b", type: "agentMessage", text: "Updated it." },
          {
            id: "g2",
            type: "fileChange",
            generatedFiles: [
              file({ content: "<p>v2 in /Users/bob/site</p>" }),
              file({
                id: "big",
                name: "big.ts",
                path: "/w/big.ts",
                language: "typescript",
                content: "x".repeat(40),
              }),
              file({
                id: "gone",
                name: "gone.txt",
                path: "/w/gone.txt",
                state: "deleted",
                content: undefined,
              }),
            ],
          },
        ],
      }),
    ]),
    { ...limits, maxArtifactBytes: 30 },
  );
  assert.deepEqual(snapshot.artifacts, [
    { title: "notes.md", language: "markdown", content: "# Notes" },
    { title: "page.html", language: "html", content: "<p>v2 in ~/site</p>" },
  ]);
  assert.deepEqual(snapshot.messages![1].artifacts, [0]);
  assert.deepEqual(snapshot.messages![3].artifacts, [1]);
});

test("incognito, empty and oversized chats are refused with a reason", () => {
  assert.throws(
    () =>
      buildConversationSnapshot(
        conversation([turn("t")], { incognito: true }),
        limits,
      ),
    /Incognito chats can't be shared/,
  );
  assert.throws(
    () => buildConversationSnapshot(conversation([]), limits),
    /nothing in this chat to share/,
  );
  assert.throws(
    () =>
      buildConversationSnapshot(
        conversation([turn("t", { prompt: "x".repeat(100_001) })]),
        limits,
      ),
    /too large to share/,
  );
  const long = conversation(
    Array.from({ length: 300 }, (_, index) => turn(`t-${index}`)),
  );
  assert.throws(() => buildConversationSnapshot(long, limits), /too large/);
  const small = buildConversationSnapshot(conversation([turn("t")]), limits);
  assert.throws(
    () =>
      buildConversationSnapshot(conversation([turn("t")]), {
        ...limits,
        maxSnapshotBytes: snapshotBytes(small) - 1,
      }),
    /too large/,
  );
});

test("only the current branch is shared", () => {
  const snapshot = buildConversationSnapshot(
    conversation([turn("t-1")], {
      savedBranches: [
        {
          id: "old",
          turns: [turn("hidden", { prompt: "the abandoned branch" })],
          providerId: "p",
          model: "m",
          visited: 0,
        },
      ],
    }),
    limits,
  );
  assert.doesNotMatch(JSON.stringify(snapshot), /abandoned/);
});

test("home folders are shortened, web addresses are not", () => {
  assert.equal(
    redactHomeFolders("see /Users/bob/x and /home/ann/y"),
    "see ~/x and ~/y",
  );
  assert.equal(redactHomeFolders("`/Users/bob`"), "`~`");
  assert.equal(redactHomeFolders("file:///Users/bob/a"), "file://~/a");
  assert.equal(redactHomeFolders("D:\\Users\\Ann\\a"), "~\\a");
  assert.equal(
    redactHomeFolders("https://example.com/home/page and ./Users/x"),
    "https://example.com/home/page and ./Users/x",
  );
  assert.deepEqual(activitySummary([]), []);
});

test("an artifact snapshot publishes the artifact as it is", () => {
  assert.deepEqual(
    buildArtifactSnapshot(
      {
        identity: "i",
        title: "Chart in /Users/bob",
        language: "tsx",
        content: "<a/>",
      },
      limits,
    ),
    {
      kind: "artifact",
      title: "Chart in ~",
      artifacts: [
        {
          title: "Chart in ~",
          language: "code",
          code_language: "tsx",
          content: "<a/>",
        },
      ],
    },
  );
  assert.throws(
    () =>
      buildArtifactSnapshot(
        {
          identity: "i",
          title: "Big",
          language: "html",
          content: "x".repeat(11),
        },
        { ...limits, maxArtifactBytes: 10 },
      ),
    /This artifact is too large to share/,
  );
  assert.deepEqual(snapshotLanguage("MD"), { language: "markdown" });
  assert.deepEqual(snapshotLanguage("mmd"), { language: "mermaid" });
  assert.deepEqual(snapshotLanguage("<script>"), {
    language: "code",
    code_language: "script",
  });
});

test("files that usually hold secrets never go into a snapshot", () => {
  for (const name of [
    ".env",
    ".env.local",
    "server.pem",
    "id_ed25519",
    ".npmrc",
    "credentials.json",
  ])
    assert.ok(secretFileName(name), name);
  for (const name of ["page.html", "env.ts", "keys.md", "README.md"])
    assert.ok(!secretFileName(name), name);
  const snapshot = buildConversationSnapshot(
    conversation([
      turn("t-1", {
        items: [
          { id: "a", type: "agentMessage", text: "Configured it." },
          {
            id: "g",
            type: "fileChange",
            changes: [{ path: "/w/.env", kind: "add", diff: "" }],
            generatedFiles: [
              file({
                id: "env",
                name: ".env",
                path: "/w/.env",
                language: "text",
                content: "API_KEY=synthetic-secret",
              }),
            ],
          },
        ],
      }),
    ]),
    limits,
  );
  assert.equal(snapshot.artifacts, undefined);
  assert.deepEqual(snapshot.messages![1].activity, ["Edited a file"]);
  assert.ok(!JSON.stringify(snapshot).includes("synthetic-secret"));
});
