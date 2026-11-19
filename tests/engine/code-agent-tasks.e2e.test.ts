import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import { readCodeAgent, stopWorkflowAgent } from "../../electron/ipc/workflow";
import { convertCodeTranscript } from "../../electron/official-ui/native/code-transcript";
import { createCodeTasks } from "../../electron/official-ui/native/code-tasks";
import { agentThreadIds } from "../../shared/workflow-usage";
import type { Conversation } from "../../shared/types";
import {
  CodexHost,
  MockResponses,
  MODEL,
  tempRoot,
  findTool,
  functionCall,
  message,
  until,
} from "../spikes/harness";

for (const stop of [false, true])
  test(
    `real Codex child task ${stop ? "stops" : "completes"} and persists in the original transcript`,
    { timeout: 120_000 },
    async () => {
      const root = tempRoot("f105-code-agents");
      const mock = await new MockResponses().start();
      const host = new CodexHost(path.join(root, "codex-home"), mock, {
        "features.multi_agent": true,
        "features.multi_agent_v2": true,
      });
      const store = new Store(path.join(root, "profile"));
      const engine = new Engine(
        store,
        "unused",
        () => "",
        () => {},
      );
      let releaseChild!: () => void;
      const childGate = new Promise<void>((resolve) => {
        releaseChild = resolve;
      });
      let childRequested = false;
      let spawned = false;
      let parentId = "";
      mock.script = async (body) => {
        if (body.client_metadata?.thread_id !== parentId) {
          childRequested = true;
          await childGate;
          return [message("F105_CHILD_OUTPUT")];
        }
        if (!spawned) {
          spawned = true;
          const tool = findTool(body, (name) => name === "spawn_agent");
          assert.ok(
            tool,
            JSON.stringify(body.tools?.map((tool: any) => tool.name)),
          );
          return [
            functionCall(tool, "f105_spawn", {
              message: "F105_CHILD_WORK",
              task_name: "inspect",
              fork_turns: "none",
            }),
          ];
        }
        return [message("F105_PARENT_DONE")];
      };
      try {
        await host.start();
        engine.rpc = host.rpc;
        engine.state = { state: "ready" };
        const cwd = path.join(root, "workspace");
        const threadId = await host.thread(MODEL, cwd, {
          approvalPolicy: "never",
        });
        parentId = threadId;
        const c: Conversation = {
          id: "parent",
          title: "Child task",
          mode: "code",
          providerId: "fixture",
          model: MODEL,
          pinned: false,
          archived: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          cwd,
          threadId,
          turns: [
            {
              id: "parent-turn",
              prompt: "F105_PARENT",
              attachments: [],
              createdAt: Date.now(),
              status: "inProgress",
              items: [],
            },
          ],
        };
        store.conversations = [c];
        engine.routes.set(threadId, c.id);
        host.rpc.on("notification", (notification) =>
          engine.notification(notification),
        );
        await host.turn(threadId, "F105_PARENT");
        const childId = c.turns.flatMap((turn) =>
          turn.items.flatMap(agentThreadIds),
        )[0];
        assert.ok(childId, JSON.stringify(c.turns));
        await until(() => childRequested, "child request");
        const context = { store, engine };
        const tasks = createCodeTasks({
          get: async () => c,
          writable: () => true,
          call: async (name, ...args) =>
            name === "readCodeAgent"
              ? readCodeAgent(context, String(args[0]), String(args[1]))
              : stopWorkflowAgent(context, String(args[0]), String(args[1])),
        });
        const thread = await readCodeAgent(context, c.id, childId);
        assert.equal(thread.id, childId);
        assert.equal(thread.turns.at(-1)?.status, "inProgress");
        const runningRows = convertCodeTranscript(c).rows;
        assert.ok(
          runningRows.some(
            (row) =>
              row.type === "system" &&
              row.subtype === "task_started" &&
              row.task_id === childId,
          ),
        );
        assert.ok(
          runningRows.some(
            (row) => row.agentId === childId && row.parent_tool_use_id,
          ),
        );
        if (stop) await tasks.stop("local_parent", childId);
        releaseChild();
        await until(
          () =>
            host.notifications.some(
              (n) =>
                n.method === "turn/completed" &&
                n.params.threadId === childId &&
                n.params.turn.status === (stop ? "interrupted" : "completed"),
            ),
          "child terminal event",
        );
        await tasks.hydrate(c);
        const finishedRows = convertCodeTranscript(c).rows;
        assert.ok(
          finishedRows.some(
            (row) =>
              row.type === "system" &&
              row.subtype === "task_notification" &&
              row.task_id === childId &&
              row.status === (stop ? "stopped" : "completed"),
          ),
        );
        assert.deepEqual(await tasks.output("local_parent", childId), {
          output: stop ? "" : "F105_CHILD_OUTPUT",
          truncated: false,
        });
        if (!stop)
          assert.ok(
            finishedRows.some(
              (row) =>
                row.agentId === childId &&
                JSON.stringify(row.message).includes("F105_CHILD_OUTPUT"),
            ),
          );
        await assert.rejects(
          tasks.stop("local_parent", "unrelated-child"),
          /not part/,
        );
        store.flush();
        const reopened = new Store(store.root);
        assert.deepEqual(
          convertCodeTranscript(reopened.conversation(c.id)).rows,
          convertCodeTranscript(c).rows,
        );
      } finally {
        releaseChild();
        engine.rpc = undefined;
        await engine.stop();
        await host.stop();
        await mock.close();
        store.flush();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
