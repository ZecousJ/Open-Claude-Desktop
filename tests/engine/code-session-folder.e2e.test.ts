import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import type { IpcHandle } from "../../electron/app/app-context";
import { Engine } from "../../electron/engine/engine";
import { resolveRuntime } from "../../electron/engine/runtime";
import { registerOfficialSessionFolder } from "../../electron/ipc/official-session-folder";
import { Store } from "../../electron/store/store";
import {
  FAKE_KEY,
  MODEL,
  MockResponses,
  findTool,
  functionCall,
  historyText,
  message,
  tempRoot,
  until,
} from "../spikes/harness";

test(
  "Code keeps its real tool cwd and original history after changing folders and restarting",
  { timeout: 120_000 },
  async (t) => {
    const root = fs.realpathSync(tempRoot("f162"));
    const profile = path.join(root, "profile");
    const target = path.join(root, "project");
    fs.mkdirSync(target);
    const mock = await new MockResponses().start();
    const serviceScript = path.join(root, "provider-service.cjs");
    const binary = resolveRuntime(process.env.CLAUDEX_RUNTIME_RESOURCES);
    let store = new Store(profile);
    let engine = new Engine(
      store,
      binary,
      () => FAKE_KEY,
      () => {},
      serviceScript,
    );
    t.after(async () => {
      await engine.stop();
      store.flush();
      await mock.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    await build({
      entryPoints: ["server/provider-service.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      outfile: serviceScript,
    });
    store.settings.providers = [
      {
        id: "mock",
        name: "Fixture",
        baseUrl: mock.url,
        protocol: "responses",
        model: MODEL,
        models: [MODEL],
      },
    ];
    store.settings.activeProviderId = "mock";
    store.settings.codeSandbox = "workspace-write";
    const handlers = new Map<string, Parameters<IpcHandle>[1]>();
    registerOfficialSessionFolder(
      (name, handler) => handlers.set(name, handler),
      {
        get store() {
          return store;
        },
        get engine() {
          return engine;
        },
        selectedFolders: new Set([target]),
        allowedFolder(folder) {
          assert.equal(folder, target);
        },
        services: {},
        push() {},
      },
    );
    const changeFolder = handlers.get("officialChangeSessionFolder")!;
    let reply = "F162_ORIGINAL_REPLY";
    let marker = "original-marker.txt";
    const executed = new Set<string>();
    mock.script = (body) => {
      if (executed.has(marker)) return [message(reply)];
      const tool = findTool(body, (name) =>
        /(^|__)(exec_command|shell_command)$/.test(name),
      );
      assert.ok(tool);
      const command =
        process.platform === "win32"
          ? `Set-Content -NoNewline -Path ${marker} -Value (Get-Location).Path; Get-Content ${marker}`
          : `pwd -P > ${marker}; cat ${marker}`;
      executed.add(marker);
      return [
        functionCall(
          tool,
          `f162_${executed.size}`,
          tool.name.endsWith("shell_command")
            ? { command, timeout_ms: 10000 }
            : { cmd: command, login: false, yield_time_ms: 10000 },
        ),
      ];
    };
    const send = async (text: string, id?: string) => {
      const { id: sessionId } = await engine.send(
        {
          text,
          conversationId: id,
          mode: "code",
          attachments: [],
          providerId: "mock",
          model: MODEL,
        },
        undefined,
        false,
        { newTaskResolved: true },
      );
      const session = store.conversation(sessionId);
      await until(() => session.turns.at(-1)?.status !== "inProgress", text);
      const turn = session.turns.at(-1);
      assert.equal(turn?.status, "completed", turn?.error);
      assert.ok(
        turn?.items.some(
          (item) => item.type === "agentMessage" && item.text === reply,
        ),
      );
      return session;
    };
    if (process.platform === "win32") await engine.setupWindowsSandbox();
    const session = await send("F162_ORIGINAL_PROMPT");
    const scratch = session.cwd!;
    const threadId = session.threadId!;
    const original = structuredClone(session.turns[0]);
    assert.equal(
      fs.readFileSync(path.join(scratch, marker), "utf8").trim(),
      scratch,
    );

    const nested = path.join(scratch, "src");
    fs.mkdirSync(nested);
    fs.mkdirSync(path.join(scratch, ".codex"));
    fs.writeFileSync(
      path.join(scratch, ".codex", "hooks.json"),
      "private hook",
    );
    fs.writeFileSync(path.join(scratch, ".env.local"), "private settings");
    fs.writeFileSync(path.join(scratch, "duplicate.txt"), "source bytes");
    fs.writeFileSync(path.join(target, "duplicate.txt"), "destination bytes");
    fs.writeFileSync(path.join(nested, "copied.txt"), "nested bytes");

    const changed = await changeFolder(session.id, target);
    assert.deepEqual(changed, {
      status: "ok",
      cwd: target,
      changed: true,
      transcriptRelocated: true,
      filesCarried: {
        outcome: "copied",
        copied: 2,
        alreadyThere: 1,
        notCopied: 2,
      },
    });
    assert.equal(
      fs.readFileSync(path.join(target, marker), "utf8").trim(),
      scratch,
    );
    assert.equal(
      fs.readFileSync(path.join(target, "src", "copied.txt"), "utf8"),
      "nested bytes",
    );
    assert.equal(
      fs.readFileSync(path.join(target, "duplicate.txt"), "utf8"),
      "destination bytes",
    );
    assert.equal(
      fs.readFileSync(path.join(scratch, "duplicate.txt"), "utf8"),
      "source bytes",
    );
    assert.equal(fs.existsSync(path.join(target, ".codex")), false);
    assert.equal(fs.existsSync(path.join(target, ".env.local")), false);
    assert.equal(session.threadId, threadId);
    assert.deepEqual(session.turns, [original]);
    marker = "after-change.txt";
    reply = "F162_CHANGE_REPLY";
    await send("F162_CHANGED_PROMPT", session.id);
    assert.equal(
      fs.readFileSync(path.join(target, marker), "utf8").trim(),
      target,
    );
    assert.equal(fs.existsSync(path.join(scratch, marker)), false);
    assert.ok(
      mock
        .forThread(threadId)
        .some(
          (body) =>
            historyText(body).includes("F162_ORIGINAL_REPLY") &&
            historyText(body).includes("F162_CHANGED_PROMPT"),
        ),
    );

    await engine.stop();
    store.flush();
    store = new Store(profile);
    engine = new Engine(
      store,
      binary,
      () => FAKE_KEY,
      () => {},
      serviceScript,
    );
    const reopened = store.conversation(session.id);
    assert.equal(reopened.threadId, threadId);
    assert.equal(reopened.cwd, target);
    assert.deepEqual(
      reopened.scratchCarried && {
        ...reopened.scratchCarried,
        left: [...reopened.scratchCarried.left].sort(),
      },
      {
        from: [scratch],
        to: target,
        left: [".codex", ".env.local", "duplicate.txt"],
      },
    );
    assert.equal(reopened.scratchFilesLeftIn, scratch);
    assert.equal(JSON.stringify(reopened.turns[0]), JSON.stringify(original));
    marker = "after-restart.txt";
    reply = "F162_RESTART_REPLY";
    await send("F162_RESTARTED_PROMPT", session.id);
    assert.equal(
      fs.readFileSync(path.join(target, marker), "utf8").trim(),
      target,
    );
    assert.equal(fs.existsSync(path.join(scratch, marker)), false);
    assert.ok(
      mock
        .forThread(threadId)
        .some(
          (body) =>
            historyText(body).includes("F162_ORIGINAL_REPLY") &&
            historyText(body).includes("F162_CHANGE_REPLY") &&
            historyText(body).includes("F162_RESTARTED_PROMPT"),
        ),
    );
  },
);
