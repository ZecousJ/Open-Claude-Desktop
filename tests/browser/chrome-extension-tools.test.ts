import assert from "node:assert/strict";
import test from "node:test";
import { browserPolicyOf, openPolicy } from "../../shared/client-policy";
import { ChromeExtensionTools } from "../../electron/browser/chrome-extension-tools";
import type { ChromeSharedPage } from "../../electron/browser/chrome-extension-bridge";
import type {
  ElicitResult,
  McpCallContext,
} from "../../electron/browser/mcp-server";

function setup() {
  let page: ChromeSharedPage = {
    id: "shared-document",
    origin: "http://127.0.0.1:4173",
    title: "Fixture",
  };
  let turn = "turn-one";
  let allowed = true;
  let blocked = false;
  const acted: string[] = [];
  const tools = new ChromeExtensionTools(
    {
      page: () => page,
      request: async (id, operation) => {
        acted.push(id);
        return operation.operation === "inspect"
          ? { text: "Chrome fixture" }
          : {};
      },
    },
    {
      offered: () => allowed,
      activeTurn: () => turn,
      policy: () =>
        blocked
          ? {
              ...openPolicy,
              browser: {
                ...browserPolicyOf(openPolicy),
                blockedDomains: ["127.0.0.1"],
              },
            }
          : openPolicy,
    },
  );
  return {
    tools,
    acted,
    setPage: (id: string) => {
      page = { ...page, id };
    },
    stop: () => {
      allowed = false;
    },
    nextTurn: () => {
      turn = "turn-two";
    },
    blockPage: () => {
      blocked = true;
    },
  };
}

function caller(
  conversationId: string,
  elicit: McpCallContext["elicit"],
): McpCallContext {
  return {
    conversationId,
    elicit,
    signal: new AbortController().signal,
    canElicit: true,
    meta: undefined,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test("Chrome approval lasts for the selected document and the approved reply", async () => {
  const { tools, acted, nextTurn, setPage } = setup();
  let prompts = 0;
  const first = caller("chat", async () => {
    prompts++;
    return { action: "accept" };
  });
  const second = caller("other-chat", async () => {
    prompts++;
    return { action: "decline" };
  });
  const read = await tools.call("inspect", {}, first);
  const content = read.content[0];
  assert.ok(content.type === "text");
  assert.match(content.text, /untrusted data.*\n.*Chrome fixture/);
  assert.equal(
    (await tools.call("scroll", { pixels: 20 }, first)).isError,
    undefined,
  );
  assert.equal(prompts, 1);
  assert.equal((await tools.call("inspect", {}, second)).isError, true);
  assert.deepEqual(acted, ["shared-document", "shared-document"]);

  nextTurn();
  assert.equal((await tools.call("inspect", {}, first)).isError, undefined);
  assert.equal(prompts, 3);
  setPage("another-document");
  assert.equal((await tools.call("inspect", {}, first)).isError, undefined);
  assert.equal(prompts, 4);
  assert.equal(acted.at(-1), "another-document");
});

test("Chrome rejects approval after the account, page, or site policy changes", async () => {
  for (const retire of [
    (fixture: ReturnType<typeof setup>) => fixture.stop(),
    (fixture: ReturnType<typeof setup>) => fixture.setPage("another-document"),
    (fixture: ReturnType<typeof setup>) => fixture.blockPage(),
  ]) {
    const fixture = setup();
    const answer = deferred<ElicitResult>();
    const offered = deferred<void>();
    const pending = fixture.tools.call(
      "inspect",
      {},
      caller("chat", () => {
        offered.resolve();
        return answer.promise;
      }),
    );
    await offered.promise;
    retire(fixture);
    answer.resolve({ action: "accept" });
    assert.equal((await pending).isError, true);
    assert.deepEqual(fixture.acted, []);
  }
});
