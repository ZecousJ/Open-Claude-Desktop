import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Engine } from "../../electron/engine/engine";
import { ChatSearchIndex } from "../../electron/memory/chat-search";
import { createMemoryExtension } from "../../electron/memory/inject";
import { LocalMemoryStore } from "../../electron/memory/local-store";
import { startMemorySearch } from "../../electron/memory/search-mcp";
import { MemoryService } from "../../electron/memory/service";
import { Store } from "../../electron/store/store";
import { openPolicy } from "../../shared/client-policy";
import { chat } from "../support/memory-fixtures";
import {
  CodexHost,
  MockResponses,
  outputs,
  reachableTools,
  tempRoot,
  toolPlan,
} from "./harness";

test(
  "Codex searches older chats after enabling search on an existing thread and stops after disabling",
  { timeout: 60_000 },
  async (t) => {
    const root = tempRoot("f051-memory-search");
    let host: CodexHost | undefined;
    let mock: MockResponses | undefined;
    let search: ReturnType<typeof startMemorySearch> | undefined;
    let memory: MemoryService | undefined;
    t.after(async () => {
      await Promise.allSettled([host?.stop(), mock?.close(), search?.close()]);
      memory?.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const store = new Store(root);
    const current = chat("current", "Current chat", [], { cwd: root });
    const older = chat("older", "Research notebook", [
      ["Amber notebook", "It is on the desk."],
    ]);
    store.conversations.push(current, older);
    const service = (memory = new MemoryService({
      store: new LocalMemoryStore(root),
      policy: () => openPolicy,
      changed() {},
    }));
    const index = new ChatSearchIndex(() => store.conversations);
    const transport = (search = startMemorySearch({
      service: () => service,
      conversation: (id) => store.conversations.find((c) => c.id === id),
      index,
    }));
    const engine = new Engine(
      store,
      "unused",
      () => "",
      () => {},
    );
    engine.policy = () => openPolicy;
    engine.extensions.add(
      createMemoryExtension({
        service: () => service,
        search: () => index,
        searchTransport: transport,
      }),
    );
    await engine.extensions.prepareAppServer();
    const upstream = (mock = await new MockResponses().start());
    host = new CodexHost(
      path.join(root, "runtime"),
      upstream,
      engine.extensions.appServerConfig(),
    );
    const runtime = await host.start();
    engine.rpc = runtime.rpc;
    const provider = store.settings.providers[0];
    const model = "grok-4";
    const run = async (stage: string) => {
      const before = upstream.requests.length;
      upstream.script = toolPlan([
        { suffix: "conversation_search", args: { query: "amber" } },
      ]);
      await engine.ensureThread(current, {
        ...engine.threadOptions(current, provider, model, "chat"),
        modelProvider: "spike",
      });
      assert.ok(current.threadId);
      const result = await runtime.turn(current.threadId, stage);
      assert.equal(result.completed.turn.status, "completed");
      return upstream.requests.slice(before);
    };

    const hasSearch = (requests: typeof upstream.requests) =>
      requests.some((body) =>
        reachableTools(body).some((tool) =>
          tool.endsWith("conversation_search"),
        ),
      );
    const before = await run("before search");
    assert.equal(hasSearch(before), false);
    const threadId = current.threadId;
    await service.setPrefs({ searchChats: true });
    const enabled = await run("after enabling search");
    assert.equal(current.threadId, threadId);
    assert.equal(hasSearch(enabled), true);
    assert.match(
      JSON.stringify(enabled.flatMap(outputs)),
      /claudex:\/\/conversation\/older/,
    );
    assert.match(JSON.stringify(enabled.flatMap(outputs)), /Amber notebook/);
    assert.equal(service.status().prefs.generate, false);
    await service.setPrefs({ searchChats: false });
    const disabled = await run("after disabling search");
    assert.equal(current.threadId, threadId);
    assert.equal(hasSearch(disabled), false);
  },
);
