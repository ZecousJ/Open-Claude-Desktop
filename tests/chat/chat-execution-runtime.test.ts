/** Real bundled Codex → loopback fixture. No paid provider or external network. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chatExecutionEnvironments } from "../../shared/chat-execution";
import { defaultSettings } from "../../electron/store/store";
import { resolveRuntime } from "../../electron/engine/runtime";
import {
  CodexHost,
  MockResponses,
  MODEL,
  message,
  findTool,
  functionCall,
  tempRoot,
  toolNames,
} from "../spikes/harness";

let available = false;
try {
  available = fs.existsSync(resolveRuntime());
} catch {}

test(
  "Chat off removes native execution dispatch; on restores file creation in the same thread",
  { skip: !available, timeout: 30000 },
  async () => {
    const root = tempRoot("chat-execution");
    const mock = await new MockResponses().start();
    const host = new CodexHost(path.join(root, "home"), mock, {
      "features.multi_agent": true,
      "features.multi_agent_v2": true,
    });
    const cwd = path.join(root, "work");
    const target = path.join(cwd, "native-execution.txt");
    let phase = "off";
    const offered: Record<string, string[]> = {};
    let called = false;
    mock.script = (body) => {
      offered[phase] ??= toolNames(body);
      if (called) return [message("DONE")];
      called = true;
      // An unsolicited model call must be refused even if it ignores the offered tools.
      const tool = findTool(body, (name) => name === "exec_command") ?? {
        name: "exec_command",
      };
      return [
        functionCall(tool, `call_${phase}`, {
          cmd: "echo created > native-execution.txt",
        }),
      ];
    };
    try {
      await host.start();
      const thread = await host.thread(MODEL, cwd, {
        config: {
          "features.multi_agent": false,
          "features.multi_agent_v2": false,
        },
        ...chatExecutionEnvironments(
          { ...defaultSettings, chatExecution: false },
          "chat",
          cwd,
        ),
      });
      await host.turn(
        thread,
        "execution off",
        chatExecutionEnvironments(
          { ...defaultSettings, chatExecution: false },
          "chat",
          cwd,
        ),
      );
      for (const tool of [
        "exec_command",
        "write_stdin",
        "apply_patch",
        "view_image",
      ])
        assert.ok(!offered.off.includes(tool), tool);
      assert.ok(!offered.off.some((name) => name.endsWith("spawn_agent")));
      assert.equal(fs.existsSync(target), false);
      phase = "on";
      called = false;
      await host.turn(
        thread,
        "execution on",
        chatExecutionEnvironments(
          { ...defaultSettings, chatExecution: true },
          "chat",
          cwd,
        ),
      );
      assert.ok(offered.on.includes("exec_command"));
      assert.ok(offered.on.includes("apply_patch"));
      assert.match(fs.readFileSync(target, "utf8"), /created/);
    } finally {
      await host.stop();
      await mock.close();
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  },
);
