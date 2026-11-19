import test from "node:test";
import assert from "node:assert/strict";
import { extensionCompatibility } from "../electron/official-ui/native/extension-compatibility";

const tools = [
  { name: "Node.js", versions: ["v20.11.0"], builtInVersion: "22.2.0" },
  { name: "Python", versions: ["Python 3.11.5"], builtInVersion: null },
];
const system = { platform: "darwin", appVersion: "0.0.39", builtInNode: true };

test("compatible requirements come from platform, app and detected runtimes", () => {
  const result = extensionCompatibility(
    {
      manifest_version: "0.4",
      server: { type: "node", mcp_config: { command: "node" } },
      compatibility: {
        platforms: ["darwin"],
        claude_desktop: ">=0.0.30",
        runtimes: { node: ">=22" },
      },
    },
    tools,
    system,
  );
  assert.equal(result.compatible, true);
  assert.deepEqual(
    result.requirements.map((item) => item.met),
    [true, true, true, true],
  );
});

test("unmet platform, runtime and manifest requirements never appear compatible", () => {
  const result = extensionCompatibility(
    {
      manifest_version: "0.5",
      server: { type: "python", mcp_config: { command: "python3" } },
      compatibility: { platforms: ["win32"], runtimes: { python: ">=3.12" } },
    },
    tools,
    system,
  );
  assert.equal(result.compatible, false);
  assert.deepEqual(
    result.requirements.map((item) => item.met),
    [false, false, false],
  );
});

test("built-in Node must be enabled and usable by the configured command", () => {
  const manifest = {
    server: { type: "node", mcp_config: { command: "/custom/node" } },
    compatibility: { runtimes: { node: ">=22" } },
  };
  assert.equal(
    extensionCompatibility(manifest, tools, system).compatible,
    false,
  );
  manifest.server.mcp_config.command = "node";
  assert.equal(
    extensionCompatibility(manifest, tools, system).compatible,
    true,
  );
  assert.equal(
    extensionCompatibility(manifest, tools, { ...system, builtInNode: false })
      .compatible,
    false,
  );
});

test("unknown manifest shapes or invalid ranges never claim a compatible runtime", () => {
  assert.throws(() =>
    extensionCompatibility({ server: { type: "unknown" } }, tools, system),
  );
  const result = extensionCompatibility(
    {
      server: { type: "node", mcp_config: { command: "node" } },
      compatibility: { runtimes: { node: "not-a-range" } },
    },
    tools,
    system,
  );
  assert.equal(result.compatible, false);
});

test("platform overrides and multiple path settings use the supported runtime", () => {
  const result = extensionCompatibility(
    {
      server: {
        type: "node",
        mcp_config: {
          command: "node",
          platform_overrides: { darwin: { command: "node" } },
        },
      },
      user_config: { folder: { type: "directory", multiple: true } },
    },
    tools,
    system,
  );
  assert.equal(result.compatible, true);
});
