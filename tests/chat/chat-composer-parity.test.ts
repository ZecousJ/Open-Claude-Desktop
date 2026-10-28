import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { doubleEscape } from "../../src/composer/double-escape";
import { placeholderOverflows } from "../../src/composer/useCompactPlaceholder";
import type {
  BrowserMcpServerOptions,
  McpCallContext,
} from "../../electron/browser/mcp-server";
import { chatGitHubLink, chatGitHubManifest } from "../../shared/chat-github";
import { openPolicy } from "../../shared/client-policy";
import { webMethodKind } from "../../shared/web-bridge-methods";
import type { Attachment, Conversation } from "../../shared/types";
import type { AppContext } from "../../electron/app/app-context";
import type {
  DynamicToolCall,
  EngineExtension,
  EngineTurnContext,
} from "../../electron/engine/engine-extensions";
import {
  chatGitHubExtension,
  readChatGitHub,
  registerChatGitHub,
  linkChatGitHubRepository,
} from "../../electron/git/chat-github";
import {
  listChatRepositories,
  listChatBranches,
} from "../../electron/git/github-repositories";

const press = {
  key: "Escape",
  repeat: false,
  isComposing: false,
  defaultPrevented: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
};

test("compact placeholders use measured text and available editor width, not a viewport breakpoint", () => {
  assert.equal(placeholderOverflows(100, 128, "14px", "14px"), false);
  assert.equal(placeholderOverflows(101, 128, "14px", "14px"), true);
  assert.equal(placeholderOverflows(300, 328, "14px", "14px"), false);
  assert.equal(placeholderOverflows(301, 328, "14px", "14px"), true);
});

test("double Escape edits only an eligible empty composer within 800ms", () => {
  const recall = doubleEscape();
  assert.equal(recall(press, true, 0), false);
  assert.equal(recall(press, true, 800), true);
  assert.equal(recall(press, true, 900), false);
  assert.equal(recall(press, true, 1701), false);
  assert.equal(recall(press, true, 1702), true);
  for (const event of [
    { ...press, key: "a" },
    { ...press, repeat: true },
    { ...press, isComposing: true },
    { ...press, defaultPrevented: true },
    { ...press, metaKey: true },
    { ...press, ctrlKey: true },
    { ...press, altKey: true },
    { ...press, shiftKey: true },
  ]) {
    const recall = doubleEscape();
    recall(press, true, 1);
    assert.equal(recall(event, true, 2), false);
    assert.equal(recall(press, true, 3), false);
  }
  const disabled = doubleEscape();
  disabled(press, true, 1);
  assert.equal(disabled(press, false, 2), false);
  assert.equal(disabled(press, true, 3), false);
  assert.equal(doubleEscape()(press, true, 3), false);
});

test("GitHub links validate repository and branch, and survive cloud attachment transfer", () => {
  const link = { repository: "octo/repo", branch: "feature/work" };
  assert.deepEqual(chatGitHubLink(link), link);
  assert.deepEqual(
    chatGitHubManifest(
      Buffer.from(JSON.stringify({ claudexGitHubRepository: true, ...link })),
    ),
    link,
  );
  for (const repository of [
    "--help",
    "https://github.com/octo/repo",
    "octo/../repo",
  ])
    assert.equal(chatGitHubLink({ ...link, repository }), undefined);
  for (const branch of [
    "",
    "main\nother",
    "main\0",
    "../main",
    "-main",
    "main?",
    "main.lock",
    "a".repeat(201),
  ])
    assert.equal(chatGitHubLink({ ...link, branch }), undefined);
  assert.equal(chatGitHubManifest(Buffer.from("plain text")), undefined);
  assert.equal(
    chatGitHubManifest(Buffer.from(JSON.stringify(link))),
    undefined,
  );
  assert.equal(webMethodKind("linkChatGitHubRepository"), "remote-runner");
});

test("linking downloads nothing; the desktop and runner read only linked repositories on demand", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chat-github-"));
  let extension: EngineExtension | undefined;
  let allowed = true;
  const calls: unknown[] = [];
  const attachments = new Map<string, Attachment>();
  let currentConversation: Conversation;
  let mcp: BrowserMcpServerOptions;
  const ctx = {
    onAccountActivated: (callback: () => void) => callback(),
    store: { root, conversation: () => currentConversation },
    selectedAttachments: attachments,
    services: {
      readChatGitHub: async (input: unknown) => {
        calls.push(input);
        return {
          encoding: "base64",
          content: Buffer.from("repository file").toString("base64"),
        };
      },
    },
    policy: () => ({ ...openPolicy, connectors: allowed ? null : [] }),
    engine: {
      extensions: {
        add: (value: EngineExtension) => {
          extension = value;
        },
      },
      peerExtensions: [],
    },
  } as unknown as AppContext;
  try {
    registerChatGitHub(ctx, (options) => {
      mcp = options;
      return {
        start: async () => {},
        close: async () => {},
        url: () => "http://127.0.0.1:1234/mcp/capability",
      };
    });
    const attachment = linkChatGitHubRepository(ctx, "octo/repo", "main");
    assert.equal(attachments.get(attachment.id), attachment);
    assert.deepEqual(chatGitHubManifest(readFileSync(attachment.path)), {
      repository: "octo/repo",
      branch: "main",
    });
    assert.equal(calls.length, 0);
    const conversation = {
      mode: "chat",
      turns: [{ attachments: [attachment] }],
    } as Conversation;
    const context = { conversation, mode: "chat" } as EngineTurnContext;
    currentConversation = conversation;
    assert.match(extension!.turnContext!(context)!.repositories, /octo\/repo/);
    assert.equal(
      extension!.builtinMcpServers!(context)![0].name,
      "claudex_github",
    );
    const call = (args: unknown) =>
      ({
        tool: "github_read",
        namespace: null,
        arguments: args,
        conversation,
      }) as DynamicToolCall;
    const read = await extension!.handleDynamicTool!(
      call({ repository: "octo/repo", branch: "main", path: "README.md" }),
    );
    assert.equal(read?.success, true);
    assert.deepEqual(read?.contentItems, [
      { type: "inputText", text: "repository file" },
    ]);
    assert.equal(mcp!.handlers.tools("c")[0].name, "github_read");
    assert.deepEqual(
      await mcp!.handlers.call(
        "github_read",
        { repository: "octo/repo", branch: "main", path: "README.md" },
        { conversationId: "c" } as McpCallContext,
      ),
      {
        isError: false,
        content: [{ type: "text", text: "repository file" }],
      },
    );
    for (const args of [
      { repository: "other/repo", branch: "main" },
      { repository: "octo/repo", branch: "other" },
      { repository: "octo/repo", branch: "main", path: "../secrets" },
      { repository: "octo/repo", branch: "main", path: "a\\b" },
    ])
      assert.equal(
        (await extension!.handleDynamicTool!(call(args)))?.success,
        false,
      );
    assert.equal(calls.length, 2);
    allowed = false;
    assert.throws(() => linkChatGitHubRepository(ctx, "octo/repo", "main"));
    assert.equal(
      (
        await extension!.handleDynamicTool!(
          call({ repository: "octo/repo", branch: "main" }),
        )
      )?.success,
      false,
    );
    assert.equal(calls.length, 2);
    assert.deepEqual(mcp!.handlers.tools("c"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GitHub tree and file reads escape branches and paths, and surface upstream failures", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: "{}", stderr: "" };
  };
  await readChatGitHub(
    { repository: "octo/repo", branch: "feature/work" },
    run,
  );
  await readChatGitHub(
    { repository: "octo/repo", branch: "feature/work", path: "src/a #?.ts" },
    run,
  );
  assert.deepEqual(calls, [
    ["api", "repos/octo/repo/git/trees/feature%2Fwork?recursive=1"],
    ["api", "repos/octo/repo/contents/src/a%20%23%3F.ts?ref=feature%2Fwork"],
  ]);
  await assert.rejects(
    readChatGitHub({ repository: "octo/repo", branch: "main" }, async () => ({
      code: 1,
      stdout: "",
      stderr: "secret",
    })),
    /Something went wrong/,
  );
  const extension = chatGitHubExtension(
    async () => {
      throw Error("token must not escape");
    },
    () => true,
  );
  const call = {
    tool: "github_read",
    namespace: null,
    arguments: { repository: "octo/repo", branch: "main" },
    conversation: {
      mode: "chat",
      turns: [
        {
          attachments: [
            { github: { repository: "octo/repo", branch: "main" } },
          ],
        },
      ],
    },
  } as unknown as DynamicToolCall;
  assert.doesNotMatch(
    JSON.stringify(await extension.handleDynamicTool!(call)),
    /token must not escape/,
  );
});

test("desktop repository and branch pickers use the user's GitHub CLI and paginate", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const rows = args[1].startsWith("user/repos")
      ? [
          {
            full_name: "octo/repo",
            name: "repo",
            owner: { login: "octo" },
            private: true,
            description: null,
            default_branch: "trunk",
            clone_url: "https://github.com/octo/repo.git",
          },
        ]
      : [
          { name: "feature/work", protected: false },
          { name: "main", protected: true },
        ];
    return { code: 0, stdout: JSON.stringify(rows), stderr: "" };
  };
  const repositories = await listChatRepositories(
    { page: 2, query: "REPO" },
    run,
  );
  assert.equal(repositories.items[0].defaultBranch, "trunk");
  assert.equal(repositories.nextPage, null);
  assert.equal(
    (await listChatBranches({ repository: "octo/repo", query: "WORK" }, run))
      .items[0].name,
    "feature/work",
  );
  assert.deepEqual(calls, [
    ["api", "user/repos?per_page=100&sort=updated&page=2"],
    ["api", "repos/octo/repo/branches?per_page=100&page=1"],
  ]);
});

test("GitHub MCP capabilities are per account and removed at sign-out", async () => {
  let activate: () => void = () => {};
  let deactivate: () => Promise<void> | undefined = () => undefined;
  const extensions: EngineExtension[] = [];
  const tokens: string[] = [];
  let closed = 0;
  let removed = 0;
  const ctx = {
    policy: () => openPolicy,
    services: {},
    onAccountActivated: (callback: () => void) => {
      activate = callback;
    },
    onAccountDeactivating: (callback: () => Promise<void> | undefined) => {
      deactivate = callback;
    },
    engine: {
      peerExtensions: [],
      extensions: {
        add: (extension: EngineExtension) => {
          extensions.push(extension);
          return () => {
            removed++;
          };
        },
      },
    },
  } as unknown as AppContext;
  const ready = registerChatGitHub(ctx, (options) => {
    tokens.push(options.token);
    return {
      start: async () => {},
      close: async () => {
        closed++;
      },
      url: (id) => `http://127.0.0.1:1234/mcp/${id}`,
    };
  });
  assert.equal(extensions.length, 0);
  activate();
  await ready();
  assert.equal(ctx.engine.peerExtensions.length, 1);
  assert.equal(
    extensions[0].dynamicTools!({ mode: "chat" } as EngineTurnContext),
    undefined,
  );
  assert.equal(
    extensions[0].processEnv!()!.CLAUDEX_CHAT_GITHUB_TOKEN,
    tokens[0],
  );
  await deactivate();
  assert.equal(closed, 1);
  assert.equal(removed, 1);
  assert.equal(ctx.engine.peerExtensions.length, 0);
  activate();
  await ready();
  assert.notEqual(tokens[0], tokens[1]);
  await deactivate();
  assert.equal(closed, 2);
});
