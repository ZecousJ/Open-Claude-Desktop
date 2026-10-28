/**
 * Deterministic Code conversations for the agent tool states: approval cards,
 * grouped tool rows, file changes and the Changes panel, background commands
 * and the plan panel. Everything is synthetic; paths point at a fixture folder.
 */
import type { Approval, Conversation, Item, Turn } from "../../shared/types";

const minute = 60_000;
const sandbox = "/Users/fixture/claude-reference-edit-sandbox";

export const appJsDiff = [
  "@@ -1,3 +1,4 @@",
  " export function greet(name) {",
  "-  return `Hello, ${name}`;",
  '+  const trimmed = (name ?? "").trim();',
  '+  return `Hello, ${trimmed || "friend"}`;',
  " }",
  "",
].join("\n");
export const utilsJs = "export function double(n) {\n  return n * 2;\n}\n";

const appAfter = [
  "export function greet(name) {",
  '  const trimmed = (name ?? "").trim();',
  '  return `Hello, ${trimmed || "friend"}`;',
  "}",
  'console.log(greet("world"));',
  "",
  "export function farewell(name) {",
  "  return `Goodbye, ${name}`;",
  "}",
];

/**
 * `git diff HEAD` for the two-file sandbox. With the default three context
 * lines app.js hides its last three lines; more context shows them.
 */
export function workingTreeDiff(context = 3) {
  const shown = Math.min(appAfter.length, 3 + context);
  const tail = appAfter.slice(3, shown).map((line) => ` ${line}`);
  return [
    "diff --git a/app.js b/app.js",
    "index 3b18e51..9c2a1f0 100644",
    "--- a/app.js",
    "+++ b/app.js",
    `@@ -1,${shown - 1} +1,${shown} @@`,
    ` ${appAfter[0]}`,
    "-  return `Hello, ${name}`;",
    `+${appAfter[1]}`,
    `+${appAfter[2]}`,
    ...tail,
    "diff --git a/utils.js b/utils.js",
    "new file mode 100644",
    "index 0000000..7d2c4b1",
    "--- /dev/null",
    "+++ b/utils.js",
    "@@ -0,0 +1,3 @@",
    "+export function double(n) {",
    "+  return n * 2;",
    "+}",
    "",
  ].join("\n");
}
export const appLineCount = appAfter.length;

const prompt =
  "Interface reference test in the current disposable folder only. Read README.md and app.js. Update app.js so greet(name) trims whitespace and returns 'Hello, friend' for a blank name. Create utils.js exporting double(n) that returns n * 2. Run node app.js once. Do not touch files outside this folder, use the network, or create a commit. Summarize the two file changes.";

function base(
  id: string,
  title: string,
  createdAt: number,
  turns: Turn[],
): Conversation {
  return {
    id,
    threadId: `thread-${id}`,
    title,
    mode: "code",
    cwd: sandbox,
    providerId: "fixture",
    model: "Opus 5.5",
    pinned: false,
    archived: false,
    createdAt,
    updatedAt: createdAt,
    turns,
  };
}

const readFiles = (at: number): Item => ({
  id: "cmd-read",
  type: "commandExecution",
  command: "cat README.md app.js",
  cwd: sandbox,
  status: "completed",
  exitCode: 0,
  aggregatedOutput: "# Greeter\n\nexport function greet(name) {\n",
  commandActions: [
    {
      type: "read",
      command: "cat README.md",
      name: "README.md",
      path: `${sandbox}/README.md`,
    },
    {
      type: "read",
      command: "cat app.js",
      name: "app.js",
      path: `${sandbox}/app.js`,
    },
  ],
  lifecycleStatus: "completed",
  startedAt: at,
  completedAt: at + 400,
});

export type ApprovalVariant =
  "edit" | "write" | "command" | "permissions" | "form" | "url" | "questions";

/** The Manual-mode reference session waiting on an approval. */
export function approvalConversation(
  createdAt: number,
  variant: ApprovalVariant,
): { conversation: Conversation; approval: Approval } {
  const items: Item[] = [readFiles(createdAt + 2_000)];
  const params: Record<string, unknown> = {
    threadId: "thread-c-approval",
    turnId: "t-approval",
    startedAtMs: createdAt + 9_000,
  };
  let method = "item/fileChange/requestApproval";
  if (variant === "edit" || variant === "write") {
    const edit = variant === "edit";
    items.push({
      id: "fc-approval",
      type: "fileChange",
      status: "inProgress",
      lifecycleStatus: "inProgress",
      startedAt: createdAt + 9_000,
      changes: [
        edit
          ? {
              path: `${sandbox}/app.js`,
              kind: { type: "update", move_path: null },
              diff: appJsDiff,
            }
          : {
              path: `${sandbox}/utils.js`,
              kind: { type: "add" },
              diff: utilsJs,
            },
      ],
    });
    params.itemId = "fc-approval";
  } else if (variant === "command") {
    method = "item/commandExecution/requestApproval";
    items.push({
      id: "cmd-node",
      type: "commandExecution",
      command: "node app.js",
      cwd: sandbox,
      status: "inProgress",
      lifecycleStatus: "inProgress",
      commandActions: [{ type: "unknown", command: "node app.js" }],
      startedAt: createdAt + 20_000,
    });
    Object.assign(params, {
      itemId: "cmd-node",
      command: "node app.js",
      cwd: sandbox,
      environmentId: null,
    });
  } else if (variant === "permissions") {
    method = "item/permissions/requestApproval";
    Object.assign(params, {
      itemId: "perm-1",
      environmentId: null,
      cwd: sandbox,
      reason: "Install the test runner from the package registry.",
      permissions: {
        network: { enabled: true },
        fileSystem: { read: null, write: ["/Users/fixture/.npm"] },
      },
    });
  } else if (variant === "form") {
    method = "mcpServer/elicitation/request";
    Object.assign(params, {
      serverName: "docs",
      mode: "form",
      _meta: null,
      message: "Choose where the new page should be published.",
      requestedSchema: {
        type: "object",
        properties: {
          title: { type: "string", title: "Page title", minLength: 3 },
          space: {
            type: "string",
            title: "Space",
            oneOf: [
              { const: "eng", title: "Engineering" },
              { const: "design", title: "Design" },
            ],
          },
          notify: { type: "boolean", title: "Notify followers", default: true },
        },
        required: ["title", "space"],
      },
    });
  } else if (variant === "url") {
    method = "mcpServer/elicitation/request";
    Object.assign(params, {
      serverName: "browser",
      mode: "url",
      _meta: null,
      message: "Sign in to finish connecting the browser tools.",
      url: "https://auth.example.com/connect?session=fixture",
      elicitationId: "elicit-1",
    });
  } else {
    method = "item/tool/requestUserInput";
    Object.assign(params, {
      itemId: "ask-1",
      autoResolutionMs: null,
      questions: [
        {
          id: "runner",
          header: "Tests",
          question: "Which test runner should the new script use?",
          isOther: true,
          isSecret: false,
          options: [
            { label: "node --test", description: "Built into Node" },
            { label: "vitest", description: "Adds a dev dependency" },
          ],
        },
        {
          id: "reporter",
          header: "Output",
          question: "Which reporter should it print?",
          isOther: true,
          isSecret: false,
          options: [
            { label: "spec", description: "One line per test" },
            { label: "dot", description: "One character per test" },
            { label: "tap", description: "Machine-readable TAP output" },
          ],
        },
      ],
    });
  }
  const turn: Turn = {
    id: "t-approval",
    prompt,
    attachments: [],
    items,
    status: "inProgress",
    createdAt,
    outputTokens: 46,
  };
  const conversation = base(
    "c-approval",
    "Interface reference test",
    createdAt,
    [turn],
  );
  return {
    conversation,
    approval: {
      id: "approval-1",
      conversationId: "c-approval",
      method,
      params,
    },
  };
}

/** Completed two-file edit with grouped rows and a turn diff. */
export function changesConversation(createdAt: number): Conversation {
  const cmd = (
    id: string,
    command: string,
    exitCode: number,
    at: number,
    output = "",
  ): Item => ({
    id,
    type: "commandExecution",
    command,
    cwd: sandbox,
    status: exitCode ? "failed" : "completed",
    exitCode,
    aggregatedOutput: output,
    commandActions: [{ type: "unknown", command }],
    lifecycleStatus: exitCode ? "failed" : "completed",
    startedAt: at,
    completedAt: at + 600,
  });
  const items: Item[] = [
    readFiles(createdAt + 2_000),
    {
      id: "fc-app",
      type: "fileChange",
      status: "completed",
      lifecycleStatus: "completed",
      changes: [
        {
          path: `${sandbox}/app.js`,
          kind: { type: "update", move_path: null },
          diff: appJsDiff,
        },
      ],
    },
    {
      id: "fc-utils",
      type: "fileChange",
      status: "completed",
      lifecycleStatus: "completed",
      changes: [
        { path: `${sandbox}/utils.js`, kind: { type: "add" }, diff: utilsJs },
      ],
    },
    cmd("cmd-1", "node app.js", 0, createdAt + 30_000, "Hello, world\n"),
    cmd(
      "cmd-2",
      "node --input-type=module -e \"import('./check.mjs')\"",
      1,
      createdAt + 34_000,
      "Error: Cannot find module './check.mjs'\n",
    ),
    cmd(
      "cmd-3",
      "node --input-type=module -e \"import { greet } from './app.js'; console.log(greet('  Ada  '))\"",
      0,
      createdAt + 38_000,
      "Hello, Ada\n",
    ),
    {
      id: "msg-changes",
      type: "agentMessage",
      text: "I made both changes and checked them with a quick `node` run. Nothing is committed.\n\n1. **app.js**: `greet(name)` now trims the name and returns `Hello, friend` when the result is empty.\n2. **utils.js** (new): exports `double(n)`, which returns `n * 2`.",
    },
    { id: "diff-t-changes", type: "diff", text: workingTreeDiff() },
  ];
  return base("c-changes", "Greet function and double utility", createdAt, [
    {
      id: "t-changes",
      prompt,
      attachments: [],
      items,
      status: "completed",
      createdAt,
    },
  ]);
}

/** A sleep left running in the background after the turn ended. */
export function backgroundConversation(createdAt: number): Conversation {
  return base("c-background", "Background sleep task inspection", createdAt, [
    {
      id: "t-background",
      prompt:
        "Reference capture continuation in this synthetic folder: start one sleep 600 Bash command in the background and leave it running so I can record the Running task panel. Report the task ID without waiting for completion.",
      attachments: [],
      status: "completed",
      createdAt,
      items: [
        {
          id: "cmd-sleep",
          type: "commandExecution",
          command: "sleep 600",
          cwd: sandbox,
          processId: "bkrqhaoa8",
          // Codex completes the exec call once it yields; the process keeps running.
          status: "completed",
          exitCode: null,
          lifecycleStatus: "completed",
          commandActions: [{ type: "unknown", command: "sleep 600" }],
          startedAt: createdAt + 3_000,
        },
        {
          id: "msg-sleep",
          type: "agentMessage",
          text: "`sleep 600` is running in the background as task `bkrqhaoa8`. It should finish on its own in about 10 minutes.",
        },
      ],
    },
  ]);
}

/** A finished multi-agent workflow: two reviewers, then a verifier. */
export function workflowConversation(createdAt: number): Conversation {
  return base("c-workflow", "Review the payment retry change", createdAt, [
    {
      id: "t-workflow",
      prompt:
        "Review the payment retry change on this branch with a workflow: one agent per area, then verify every finding before reporting.",
      attachments: [],
      status: "completed",
      createdAt,
      items: [
        {
          id: "msg-workflow",
          type: "agentMessage",
          text: "I'll split the review across the retry logic and its tests, then have a verifier check each finding against the code.",
        },
        {
          id: "spawn-workflow",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "completed",
          receiverThreadIds: [
            "agent-review-retry",
            "agent-review-tests",
            "agent-verify",
          ],
          prompt:
            "Review the retry backoff, idempotency keys and the new tests; verify each finding before it is reported",
          workflowPhases: ["Review", "Verify"],
          agentTokenUsage: {
            "agent-review-retry": 48210,
            "agent-review-tests": 31877,
            "agent-verify": 12405,
          },
          model: "Opus 5.5",
          agentsStates: {
            "agent-review-retry": {
              status: "completed",
              message: "3 findings",
            },
            "agent-review-tests": { status: "completed", message: "1 finding" },
            "agent-verify": { status: "completed", message: "3 confirmed" },
          },
        },
        {
          id: "activity-review-retry",
          type: "subAgentActivity",
          kind: "started",
          agentThreadId: "agent-review-retry",
          agentPath: "/root/review:retry-logic",
        },
        {
          id: "activity-review-tests",
          type: "subAgentActivity",
          kind: "started",
          agentThreadId: "agent-review-tests",
          agentPath: "/root/review:tests",
        },
        {
          id: "activity-verify",
          type: "subAgentActivity",
          kind: "started",
          agentThreadId: "agent-verify",
          agentPath: "/root/verify:findings",
        },
        {
          id: "msg-workflow-done",
          type: "agentMessage",
          text: "The verifier confirmed three of the four findings:\n\n1. **Backoff ignores `Retry-After`**: a 429 from the provider is retried after 200 ms instead of the time it asks for.\n2. **Idempotency key changes on retry**: `chargeOnce` builds a new key per attempt, so a timeout followed by a retry can charge twice.\n3. **No test for the final failure**: the tests stop at the second attempt and never check that the third failure is reported.\n\nThe fourth (a missing jitter cap) was already handled in `backoff.ts`.",
        },
      ],
    },
  ]);
}

/** Plan steps from turn/plan/updated with the first two done. */
export function planConversation(createdAt: number): Conversation {
  return base("c-plan", "Reference parity pass", createdAt, [
    {
      id: "t-plan",
      prompt:
        "Match the sidebar to the reference captures, then split the large components.",
      attachments: [],
      status: "inProgress",
      createdAt,
      outputTokens: 4_012,
      items: [
        {
          id: "plan-t-plan",
          type: "taskPlan",
          plan: [
            { step: "Rebase branch onto latest main", status: "completed" },
            {
              step: "Set up reference materials and browser harness",
              status: "completed",
            },
            {
              step: "Match referenced components to original screenshots (sidebar first)",
              status: "inProgress",
            },
            {
              step: "Split large components while developing",
              status: "pending",
            },
            { step: "Verify, document and push", status: "pending" },
          ],
        },
        {
          id: "cmd-plan",
          type: "commandExecution",
          command: "npm test",
          cwd: sandbox,
          status: "inProgress",
          lifecycleStatus: "inProgress",
          commandActions: [{ type: "unknown", command: "npm test" }],
          startedAt: createdAt + 60_000,
        },
      ],
    },
  ]);
}

export const fixtureMinute = minute;

/** Chat turn that ran a command and then called a connector tool. */
export function mixedToolsConversation(createdAt: number): Conversation {
  return {
    ...base("c-mixed", "Connector lookup", createdAt, [
      {
        id: "t-mixed",
        prompt:
          "Run echo hi, then look up the release notes page with the docs connector.",
        attachments: [],
        status: "completed",
        createdAt,
        items: [
          {
            id: "cmd-echo",
            type: "commandExecution",
            command: "echo hi",
            status: "completed",
            lifecycleStatus: "completed",
            exitCode: 0,
            aggregatedOutput: "hi\n",
          },
          {
            id: "mcp-docs",
            type: "mcpToolCall",
            server: "docs",
            tool: "search",
            status: "completed",
            lifecycleStatus: "completed",
            arguments: { query: "release notes" },
            result: {
              content: [{ type: "text", text: "Release notes: 3 pages" }],
            },
          },
          {
            id: "msg-mixed",
            type: "agentMessage",
            text: "The command printed `hi`, and the docs connector found three release-notes pages.",
          },
        ],
      },
    ]),
    mode: "chat",
    cwd: undefined,
  };
}

/** Plan mode finished with a proposed plan, waiting for approval. */
export function planApprovalConversation(createdAt: number): Conversation {
  return base("c-plan-approval", "Plan the greeting refactor", createdAt, [
    {
      id: "t-plan-approval",
      prompt: "Plan how to make greet() handle blank names. Do not edit yet.",
      attachments: [],
      status: "completed",
      createdAt,
      items: [
        readFiles(createdAt + 2_000),
        {
          id: "plan-item",
          type: "plan",
          text: "## Plan\n\n1. Trim `name` in `greet()` and fall back to `friend` when it is empty.\n2. Add `utils.js` with `double(n)`.\n3. Run `node app.js` once to check the output.",
        },
      ],
    },
  ]);
}
