import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { resolveRuntime } from "../../electron/engine/runtime";
import { registerResumableSessions } from "../../electron/ipc/resumable-sessions";
import type { Context } from "../../electron/ipc/conversations";
import { registerCliResume } from "../../electron/official-ui/native/cli-resume";
import type { NativeHost } from "../../electron/official-ui/native/host";
import { Store } from "../../electron/store/store";
import {
  CodexHost,
  MockResponses,
  historyText,
  message,
} from "../spikes/harness";

const resources = process.env.CLAUDEX_RUNTIME_RESOURCES;

test(
  "Code recovery lists only the Claudex engine history and leaves external CLI transcripts untouched",
  { skip: !resources },
  async (t) => {
    assert.match(
      execFileSync(resolveRuntime(resources), ["--version"], {
        encoding: "utf8",
      }),
      /\b0\.149\.1\b/,
    );
    const root = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), "claudex-f106-cli-")),
    );
    const cwd = path.join(root, "fixture-workspace");
    const cliConfig = path.join(root, "claude-config");
    const project = path.join(cliConfig, "projects", "fixture");
    const account = path.join(root, "account");
    const codex = path.join(account, "codex-home");
    mkdirSync(project, { recursive: true });
    const mock = new MockResponses();
    await mock.start();
    mock.script = (_, index) => [
      message(index === 0 ? "CODEX_PRIOR_REPLY" : "CODEX_RESUMED_REPLY"),
    ];
    let runtime = await new CodexHost(codex, mock).start();
    t.after(async () => {
      await runtime.stop();
      await mock.close();
      rmSync(root, { recursive: true, force: true });
    });
    const nativeThread = await runtime.thread("gpt-5.4", cwd);
    const initial = await runtime.turn(nativeThread, "CODEX_PRIOR_PROMPT");
    assert.equal(initial.completed.turn.status, "completed");
    await runtime.stop();
    runtime = await new CodexHost(codex, mock).start();

    const sessionId = randomUUID();
    const user = randomUUID(),
      assistant = randomUUID(),
      result = randomUUID();
    const cliRow = (
      type: "user" | "assistant",
      uuid: string,
      parentUuid: string | null,
      content: unknown,
    ) => ({
      type,
      uuid,
      parentUuid,
      timestamp: "2026-11-01T00:00:00.000Z",
      sessionId,
      cwd,
      gitBranch: "fixture/cli",
      message: {
        role: type,
        content,
        stop_reason: type === "assistant" ? "tool_use" : null,
      },
      ...(type === "assistant" && {
        claudexReasoning: ["CLAUDE_CLI_RECORDED_REASONING"],
      }),
    });
    const externalTranscript = path.join(project, sessionId + ".jsonl");
    writeFileSync(
      externalTranscript,
      [
        cliRow("user", user, null, [
          { type: "text", text: "CLAUDE_CLI_PROMPT" },
        ]),
        cliRow("assistant", assistant, user, [
          { type: "text", text: "CLAUDE_CLI_REPLY" },
          {
            type: "tool_use",
            id: "toolu_fixture",
            name: "Bash",
            input: { command: "printf CLAUDE_CLI_TOOL" },
          },
        ]),
        cliRow("user", result, assistant, [
          {
            type: "tool_result",
            tool_use_id: "toolu_fixture",
            content: "CLAUDE_CLI_TOOL",
            is_error: false,
          },
        ]),
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    const externalBefore = readFileSync(externalTranscript);
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cliConfig;
    t.after(() => {
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    });
    let store = new Store(account);
    store.settings.providers[0].model = "gpt-5.4";
    store.flush();
    const makeBridge = () => {
      const rpc = new Map<string, (...args: unknown[]) => unknown>();
      const methods = new Map<string, (...args: unknown[]) => unknown>();
      const engine = {
        environment: { kind: "local" },
        resumeSessionRequest: (method: string, params: object) =>
          runtime.rpc.call(method, params),
      };
      registerResumableSessions((method, handler) => rpc.set(method, handler), {
        store,
        engine,
        activeAccount: { id: "fixture-owner" },
        accountGeneration: () => 1,
        allowedFolder: (folder?: string) => assert.equal(folder, cwd),
      } as Context);
      const host = {
        ctx: {
          account: () => ({ id: "fixture-owner" }),
          localCall: async (method: string, ...args: unknown[]) =>
            rpc.get(method)!(...args),
        },
        emit: () => {},
        on: (method: string, handler: (...args: unknown[]) => unknown) =>
          methods.set(method, handler),
      } as unknown as NativeHost;
      registerCliResume(host);
      return async (method: string, ...args: unknown[]): Promise<any> =>
        methods.get("LocalSessions." + method)!(...args);
    };
    let call = makeBridge();
    assert.deepEqual(await call("listCliSessions", 200), []);
    const available = await call("listResumableCliSessions");
    const native = available.find(
      (row: { title: string }) => row.title === "CODEX_PRIOR_PROMPT",
    );
    assert.equal(available.length, 1);
    assert.ok(native, JSON.stringify(available));
    assert.equal(native.liveness, "not_running");
    assert.notEqual(native.handle, nativeThread);
    assert.deepEqual(await call("previewCliResume", native.handle), {
      resumable: true,
      model: store.settings.providers[0].model,
    });
    const codexTail = await call("readCliTranscript", native.handle, 1, 1);
    assert.equal(codexTail.totalMessages, 2);
    assert.match(JSON.stringify(codexTail.messages), /CODEX_PRIOR_REPLY/);
    assert.equal(store.conversations.length, 0);
    const resumed = await call("resumeCliSession", native.handle);
    assert.equal(resumed.ok, true);
    assert.deepEqual(await call("resumeCliSession", native.handle), resumed);
    assert.equal(store.conversations.length, 1);
    await runtime.stop();
    store = new Store(account);
    runtime = await new CodexHost(codex, mock).start();
    call = makeBridge();
    assert.deepEqual(await call("listResumableCliSessions"), []);
    const persisted = store.conversations.find(
      (entry) => "local_" + entry.id === resumed.sessionId,
    );
    assert.equal(persisted?.threadId, nativeThread);
    assert.equal(persisted?.turns[0].prompt, "CODEX_PRIOR_PROMPT");
    assert.deepEqual(readFileSync(externalTranscript), externalBefore);
    await runtime.rpc.call("thread/resume", {
      threadId: nativeThread,
      excludeTurns: true,
    });
    const continuation = await runtime.turn(
      nativeThread,
      "CODEX_RESUMED_PROMPT",
    );
    assert.equal(continuation.completed.turn.status, "completed");
    assert.match(historyText(mock.requests.at(-1)!), /CODEX_PRIOR_PROMPT/);
    assert.match(historyText(mock.requests.at(-1)!), /CODEX_PRIOR_REPLY/);
    assert.match(historyText(mock.requests.at(-1)!), /CODEX_RESUMED_PROMPT/);
  },
);
