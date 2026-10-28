import test from "node:test";
import assert from "node:assert/strict";
import { augmentToolSchemas } from "../../server/tool-descriptions";
import { toChat } from "../../electron/engine/gateway-chat";

const execCommand = {
  type: "function",
  name: "exec_command",
  strict: false,
  description: "Runs a command in a PTY.",
  parameters: {
    type: "object",
    properties: { cmd: { type: "string" }, workdir: { type: "string" } },
    required: ["cmd"],
    additionalProperties: false,
  },
};
const request = () => ({
  model: "gpt-5.2-codex",
  tools: [
    execCommand,
    {
      type: "function",
      name: "shell_command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
      },
    },
    {
      type: "function",
      name: "shell",
      parameters: {
        type: "object",
        properties: { command: { type: "array" } },
        required: ["command", "description"],
      },
    },
    {
      type: "namespace",
      name: "multi_agent_v1",
      tools: [
        {
          type: "function",
          name: "exec_command",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    {
      type: "function",
      name: "mcp__server/exec_command",
      parameters: { type: "object", properties: {} },
    },
    { type: "custom", name: "apply_patch", format: { type: "grammar" } },
    { type: "web_search", external_web_access: true },
  ],
});

test("only Codex's three shell function tools get a required description", () => {
  const original = request();
  const snapshot = structuredClone(original);
  const augmented = augmentToolSchemas(original);
  assert.deepEqual(original, snapshot, "the request from Codex is unchanged");
  const [exec, shellCommand, shell, namespace, mcp, custom, web] =
    augmented.tools as any[];
  assert.equal(exec.parameters.properties.description.type, "string");
  assert.match(
    exec.parameters.properties.description.description,
    /5-10 words/,
  );
  assert.deepEqual(exec.parameters.required, ["cmd", "description"]);
  assert.equal(exec.parameters.additionalProperties, false);
  assert.equal(exec.strict, false, "strict is never turned on");
  assert.deepEqual(shellCommand.parameters.required, ["description"]);
  assert.deepEqual(
    shell.parameters.required,
    ["command", "description"],
    "description is not listed twice",
  );
  assert.deepEqual(namespace, snapshot.tools[3]);
  assert.deepEqual(mcp, snapshot.tools[4]);
  assert.deepEqual(custom, snapshot.tools[5]);
  assert.deepEqual(web, snapshot.tools[6]);
});

test("an existing description property is kept and odd tools are skipped", () => {
  const own = {
    type: "function",
    name: "exec_command",
    parameters: {
      type: "object",
      properties: { description: { type: "string", description: "Theirs" } },
    },
  };
  const unchanged = { tools: [own, { type: "function", name: "shell" }] };
  assert.equal(augmentToolSchemas(unchanged), unchanged);
  const noTools = { model: "m", input: [] };
  assert.equal(augmentToolSchemas(noTools), noTools);
});

test("the Chat bridge sees the description parameter", () => {
  const { body } = toChat({
    model: "m",
    input: "hi",
    tools: augmentToolSchemas({ tools: [execCommand] }).tools,
  });
  const fn = body.tools[0].function;
  assert.equal(fn.name, "exec_command");
  assert.deepEqual(fn.parameters.required, ["cmd", "description"]);
  assert.ok(fn.parameters.properties.description);
});
