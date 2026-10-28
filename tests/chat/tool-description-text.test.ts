import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Item, Turn } from "../../shared/types";
import {
  commandDescriptionText,
  describeCommand,
  pastTense,
  runningTense,
} from "../../src/code-tools/tool-description-text";
import {
  commandState,
  toolSummary,
} from "../../src/code-tools/code-tool-model";
import {
  CodeCommandActivity,
  commandLabel,
} from "../../src/code-tools/CodeCommandActivity";
import { AgentCommandGroup } from "../../src/transcript/agents/AgentCommandGroup";
import { ChatTurnContent } from "../../src/transcript/ChatTurnContent";
import { stepLine } from "../../src/transcript/chat-step-lines";

const command = (id: string, extra: Partial<Item> = {}): Item => ({
  id,
  type: "commandExecution",
  command: "true",
  aggregatedOutput: "",
  status: "completed",
  lifecycleStatus: "completed",
  exitCode: 0,
  ...extra,
});

test("the reference rows' past tenses", () => {
  // The panel title "Check greet against README" becomes "Checked …".
  assert.equal(
    pastTense("Check greet against README"),
    "Checked greet against README",
  );
  assert.equal(pastTense("List repository files"), "Listed repository files");
  assert.equal(
    pastTense("Show uncommitted changes to app.js"),
    "Showed uncommitted changes to app.js",
  );
  assert.equal(pastTense("Read README.md"), "Read README.md");
  assert.equal(pastTense("Initialize session"), "Initialized session");
});

test("past tense: irregular, doubled, -e, consonant + y, and plain verbs", () => {
  const cases: [string, string][] = [
    ["Run the unit tests", "Ran the unit tests"],
    ["Find large files", "Found large files"],
    ["Build the app", "Built the app"],
    ["Write the config", "Wrote the config"],
    ["Get the current branch", "Got the current branch"],
    ["Sleep 5 seconds", "Slept 5 seconds"],
    ["Rerun failing tests", "Reran failing tests"],
    ["Reset the index", "Reset the index"],
    ["Set the upstream", "Set the upstream"],
    ["Checkout main", "Checked out main"],
    ["Stop the server", "Stopped the server"],
    ["Commit the fix", "Committed the fix"],
    ["Grep for TODO", "Grepped for TODO"],
    ["Tag the release", "Tagged the release"],
    ["Scan dependencies", "Scanned dependencies"],
    ["Create a branch", "Created a branch"],
    ["Remove build output", "Removed build output"],
    ["Compile the sources", "Compiled the sources"],
    ["Copy the fixture", "Copied the fixture"],
    ["Verify the signature", "Verified the signature"],
    ["Try again", "Tried again"],
    ["Deploy the preview", "Deployed the preview"],
    ["Print the version", "Printed the version"],
    ["Install dependencies", "Installed dependencies"],
    ["Wait 60 seconds", "Waited 60 seconds"],
    ["Fix lint errors", "Fixed lint errors"],
    ["Search for usages", "Searched for usages"],
    ["Push the branch", "Pushed the branch"],
    ["Check", "Checked"],
    ["Check: the tests", "Checked: the tests"],
  ];
  for (const [input, expected] of cases)
    assert.equal(pastTense(input), expected, input);
});

test("past tense leaves words it does not know, other scripts and odd case alone", () => {
  for (const sentence of [
    "Frobnicate the widget",
    "Listed repository files",
    "Running tests",
    "NPM install",
    "npm install",
    "列出仓库文件",
    "Liste les fichiers",
    "Run-time check",
    "",
  ])
    assert.equal(pastTense(sentence), sentence, sentence);
});

test("describeCommand words each state", () => {
  const d = "Run a shell that exits with code 7";
  assert.equal(describeCommand(d, "running"), d);
  assert.equal(
    describeCommand(d, "completed"),
    "Ran a shell that exits with code 7",
  );
  // R-Code-失败命令-完成折叠.
  assert.equal(
    describeCommand(d, "failed"),
    "Failed to run a shell that exits with code 7",
  );
  // R-0786.
  assert.equal(
    describeCommand("Wait 60 seconds so the run finishes", "failed"),
    "Failed to wait 60 seconds so the run finishes",
  );
  assert.equal(describeCommand(d, "interrupted"), d);
  // An acronym keeps its case; another script is shown as written.
  assert.equal(
    describeCommand("NPM install the workspace", "failed"),
    "Failed to NPM install the workspace",
  );
  assert.equal(describeCommand("列出仓库文件", "failed"), "列出仓库文件");
  assert.equal(describeCommand("列出仓库文件", "completed"), "列出仓库文件");
  assert.equal(describeCommand("run tests", "failed"), "Failed to run tests");
});

test("a Code row words a running description in the present progressive, Chat keeps the sentence", () => {
  for (const [sentence, now] of [
    ["Run tests", "Running tests"],
    ["Stop the dev server", "Stopping the dev server"],
    ["Make the build", "Making the build"],
    ["Set the flag", "Setting the flag"],
    ["Read the log", "Reading the log"],
    ["List files, then sort them", "Listing files, then sort them"],
    ["Show uncommitted changes", "Showing uncommitted changes"],
    ["Commit the fix", "Committing the fix"],
    ["Sync the branch", "Syncing the branch"],
    ["Checkout main", "Checking out main"],
    ["Fix the lint errors", "Fixing the lint errors"],
  ])
    assert.equal(runningTense(sentence), now, sentence);
  // Unknown words, other scripts and an already-progressive sentence stay.
  for (const sentence of [
    "Running tests",
    "Tests",
    "列出仓库文件",
    "NPM install",
    "",
  ])
    assert.equal(runningTense(sentence), sentence, sentence);
  const d = "Run tests";
  assert.equal(describeCommand(d, "running", true), "Running tests");
  assert.equal(describeCommand(d, "running"), d);
  assert.equal(describeCommand(d, "completed", true), "Ran tests");
  assert.equal(describeCommand(d, "failed", true), "Failed to run tests");
});

test("commandState follows the item's lifecycle", () => {
  assert.equal(commandState(command("a")), "completed");
  assert.equal(
    commandState(command("b", { lifecycleStatus: "inProgress" })),
    "running",
  );
  assert.equal(commandState(command("c", { exitCode: 7 })), "failed");
  assert.equal(
    commandState(command("d", { lifecycleStatus: "failed", exitCode: null })),
    "failed",
  );
  assert.equal(
    commandState(command("e", { lifecycleStatus: "interrupted" })),
    "interrupted",
  );
});

test("commandDescriptionText cleans the description and skips what it cannot use", () => {
  assert.equal(
    commandDescriptionText(
      command("a", { description: "  List\u202e repository\n files " }),
      "completed",
    ),
    "Listed repository files",
  );
  assert.equal(commandDescriptionText(command("b"), "completed"), undefined);
  assert.equal(
    commandDescriptionText(
      command("c", { description: " \u200b " }),
      "running",
    ),
    undefined,
  );
  assert.equal(
    commandDescriptionText(
      command("d", { description: 42 as unknown as string }),
      "running",
    ),
    undefined,
  );
  assert.equal(
    commandDescriptionText(
      command("e", { description: "List files" }),
      "interrupted",
    ),
    undefined,
  );
  assert.equal(
    commandDescriptionText(
      { id: "f", type: "mcpToolCall", description: "List files" } as Item,
      "completed",
    ),
    undefined,
  );
});

test("commandLabel uses the description in every state and falls back without one", () => {
  const description = "Run a shell that exits with code 7";
  assert.equal(
    commandLabel(command("r", { description, lifecycleStatus: "inProgress" })),
    "Running a shell that exits with code 7",
  );
  assert.equal(
    commandLabel(command("c", { description })),
    "Ran a shell that exits with code 7",
  );
  assert.equal(
    commandLabel(
      command("f", { description, exitCode: 7, lifecycleStatus: "failed" }),
    ),
    "Failed to run a shell that exits with code 7",
  );
  // Stopped commands keep "Command stopped" (R7 default).
  assert.equal(
    commandLabel(command("i", { description, lifecycleStatus: "interrupted" })),
    "Command stopped",
  );
  assert.equal(commandLabel(command("n")), "Ran a command");
  assert.equal(
    commandLabel(command("n2", { lifecycleStatus: "inProgress" })),
    "Running a command",
  );
  assert.equal(
    commandLabel(command("n3", { exitCode: 1, lifecycleStatus: "failed" })),
    "Failed to run a command",
  );
});

test("a command without a description names its short form in code", async () => {
  const { commandSubject } =
    await import("../../src/code-tools/command-subject");
  assert.equal(commandSubject("git status"), "git status");
  assert.equal(
    commandSubject("cd /tmp/x && npm run test -- --watch"),
    "npm run test…",
  );
  assert.equal(commandSubject("curl https://example.com"), undefined);
  assert.equal(commandSubject("export TOKEN=abc && git push"), undefined);
  assert.equal(commandSubject("make\nnext"), "make…");
  const html = renderToStaticMarkup(
    createElement(
      "div",
      null,
      commandLabel(command("g", { command: "git status" })),
    ),
  );
  assert.match(
    html,
    /Ran <code class="code-command-subject">git status<\/code>/,
  );
});

test("the Code row renders the description as plain text with a full-text title", () => {
  const html = renderToStaticMarkup(
    createElement(CodeCommandActivity, {
      item: command("x", {
        description: "Print <b>bold</b> text",
        exitCode: 7,
        lifecycleStatus: "failed",
        command: "sh -c 'exit 7'",
      }),
    }),
  );
  assert.match(html, /data-failed="true"/);
  assert.match(html, /Failed to print &lt;b&gt;bold&lt;\/b&gt; text/);
  assert.match(html, /title="Failed to print &lt;b&gt;bold&lt;\/b&gt; text"/);
  assert.doesNotMatch(html, /<b>/);
  const plain = renderToStaticMarkup(
    createElement(CodeCommandActivity, { item: command("y") }),
  );
  assert.doesNotMatch(plain, /title=/);
});

test("a running group summary names the running command's description (R-0787)", () => {
  const items = [
    command("a", { description: "List repository files" }),
    command("b", {
      description: "Run the unit tests",
      lifecycleStatus: "inProgress",
    }),
  ];
  assert.equal(toolSummary(items), "Running the unit tests");
  // Without a description the running summary keeps its kind.
  assert.equal(
    toolSummary([items[0], command("c", { lifecycleStatus: "inProgress" })]),
    "Running a command",
  );
  // Finished groups keep their counts.
  assert.equal(
    toolSummary([items[0], command("d", { description: "Run tests" })]),
    "Ran 2 commands",
  );
});

test("the agent tool list shows past-tense and failed descriptions (R-0786)", () => {
  const html = renderToStaticMarkup(
    createElement(AgentCommandGroup, {
      commands: [
        command("l", { description: "List repository files" }),
        command("s", { description: "Show uncommitted changes to greet.py" }),
        command("w", {
          description: "Wait 60 seconds so the run finishes",
          exitCode: 1,
          lifecycleStatus: "failed",
        }),
      ],
    }),
  );
  assert.match(html, /Listed repository files/);
  assert.match(html, /Showed uncommitted changes to greet.py/);
  assert.match(html, /Failed to wait 60 seconds so the run finishes/);
  assert.match(html, /Ran 3 commands \(1 failed\)/);
});

const chatTurn = (items: Item[], status: Turn["status"]): Turn => ({
  id: "t",
  prompt: "test",
  attachments: [],
  createdAt: Date.now(),
  status,
  items,
});
const renderChat = (turn: Turn) =>
  renderToStaticMarkup(
    createElement(ChatTurnContent, {
      turn,
      awaitingApproval: false,
      onArtifact: () => {},
    }),
  );

test("Chat's activity label: running description, then its single-command outcome", () => {
  const description = "Change button label to Add";
  // The running row reads as the model's sentence.
  const running = renderChat(
    chatTurn(
      [command("c", { description, lifecycleStatus: "inProgress" })],
      "inProgress",
    ),
  );
  assert.match(running, /Change button label to Add/);
  assert.doesNotMatch(running, /Running a command/);
  const done = renderChat(
    chatTurn(
      [
        command("c", { description }),
        { id: "m", type: "agentMessage", text: "Done." },
      ],
      "completed",
    ),
  );
  // Finished: the group counts, the step keeps the model's sentence in the past
  // tense.
  assert.match(done, /class="activity-label">Ran a command</);
  assert.equal(
    stepLine(command("c", { description })).text,
    "Changed button label to Add",
  );
  const failed = renderChat(
    chatTurn(
      [
        command("c", { description, exitCode: 1, lifecycleStatus: "failed" }),
        { id: "m", type: "agentMessage", text: "It failed." },
      ],
      "completed",
    ),
  );
  assert.equal(
    stepLine(
      command("c", { description, exitCode: 1, lifecycleStatus: "failed" }),
    ).text,
    "Failed to change button label to Add",
  );
  // The row says what ran; its outcome is the word after it (84e60ffb).
  assert.match(failed, /class="activity-label">Ran a command</);
  assert.match(failed, /chat-steps-outcome"[^>]*>Failed</);
});

test("Chat keeps counts for several commands and fallbacks without descriptions", () => {
  const several = renderChat(
    chatTurn(
      [
        command("a", { description: "List files" }),
        command("b", { description: "Run tests" }),
        { id: "m", type: "agentMessage", text: "Done." },
      ],
      "completed",
    ),
  );
  assert.match(several, /Ran 2 commands/);
  const bare = renderChat(
    chatTurn(
      [command("a"), { id: "m", type: "agentMessage", text: "Done." }],
      "completed",
    ),
  );
  assert.match(bare, /Ran a command/);
  const stopped = renderChat(
    chatTurn(
      [
        command("a", {
          description: "Run tests",
          lifecycleStatus: "interrupted",
        }),
      ],
      "interrupted",
    ),
  );
  assert.match(stopped, /chat-steps-outcome" data-tone="secondary">Stopped</);
  assert.equal(
    stepLine(
      command("a", {
        description: "Run tests",
        lifecycleStatus: "interrupted",
      }),
    ).text,
    "Command stopped",
  );
});
import { before as beforeChatSteps } from "node:test";
import { preloadChatSteps } from "../../src/transcript/ChatTurnContent";
beforeChatSteps(() => preloadChatSteps());
