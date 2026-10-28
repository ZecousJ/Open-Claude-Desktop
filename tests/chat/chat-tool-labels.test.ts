import assert from "node:assert/strict";
import test from "node:test";
import type { Item } from "../../shared/types";
import { chatStepsSummary } from "../../src/transcript/ChatSteps";
import { stepLine } from "../../src/transcript/chat-step-lines";
import { toolRunningLabel } from "../../src/transcript/tools/tool-running-label";

const tool = (name?: string, status = "inProgress"): Item => ({
  id: "tool",
  type: "dynamicToolCall",
  tool: name,
  status,
});

test("named tools keep their names and unnamed tools keep the fallback", () => {
  for (const type of ["dynamicToolCall", "mcpToolCall"]) {
    assert.equal(
      stepLine({ ...tool("Calendar", "completed"), type }).text,
      "Used Calendar",
    );
    assert.equal(
      chatStepsSummary([{ ...tool("Calendar", "completed"), type }]),
      "Used Calendar",
    );
    assert.equal(
      stepLine({ ...tool(undefined, "completed"), type }).text,
      "Used a tool",
    );
    assert.equal(
      chatStepsSummary([{ ...tool(undefined, "completed"), type }]),
      "Used a tool",
    );
  }
  assert.equal(stepLine(tool("Calendar")).text, "Using Calendar…");
});

test("running tools use the official per-tool labels, including Codex aliases", () => {
  const cases = {
    WebFetch: "Fetching from site",
    WebSearch: "Searching the web…",
    REPL: "Running code…",
    JavaScript: "Running code…",
    AppifactRepl: "Running code…",
    mcp__node_repl__js: "Running code…",
    Tmux: "Running terminal…",
    Agent: "Multitasking…",
    AskUserQuestion: "Asking a question…",
    Glob: "Looking for files…",
    Grep: "Searching files…",
    LS: "Listing files…",
    TodoWrite: "Updating the plan…",
    ToolSearch: "Loading tools…",
    SendUserFile: "Sharing files…",
    Poll: "Waiting for results…",
    Read: "Reading a file…",
    Write: "Creating a file…",
    Edit: "Editing a file…",
    Bash: "Running a command…",
    "functions.exec_command": "Running a command…",
    "functions.update_plan": "Updating the plan…",
    "functions.wait_agent": "Waiting for results…",
  };
  for (const [name, label] of Object.entries(cases))
    assert.equal(stepLine(tool(name)).text, label, name);
  assert.equal(
    toolRunningLabel({
      ...tool("Read"),
      arguments: { file_path: "/project/readme.md" },
    }),
    "Reading readme.md…",
  );
  assert.equal(
    toolRunningLabel({
      ...tool("Edit"),
      input: { file_path: "C:\\project\\readme.md" },
    }),
    "Editing readme.md…",
  );
});

test("Codex web, file and command steps use the matching running labels", () => {
  assert.equal(
    stepLine({ id: "web", type: "webSearch", status: "inProgress" }).text,
    "Searching the web",
  );
  assert.equal(
    stepLine({
      id: "web",
      type: "webSearch",
      status: "inProgress",
      action: { type: "openPage", url: "https://example.com" },
    }).text,
    "Fetching from example.com",
  );
  assert.equal(
    stepLine({
      id: "file",
      type: "fileChange",
      status: "inProgress",
      changes: [{ path: "/new.txt", kind: "add", diff: "" }],
    }).text,
    "Creating a file…",
  );
  for (const [action, label] of [
    ["search", "Searching files…"],
    ["listFiles", "Listing files…"],
  ])
    assert.equal(
      stepLine({
        id: "command",
        type: "commandExecution",
        status: "inProgress",
        commandActions: [{ type: action }],
      }).text,
      label,
    );
});
