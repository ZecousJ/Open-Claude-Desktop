import test from "node:test";
import assert from "node:assert/strict";
import { registerPrivacyDataHandlers } from "../../electron/ipc/privacy-data";
import { Sub2ApiClient } from "../../electron/sub2api/client";
import type { AppContext } from "../../electron/app/app-context";
import { webMethodKind } from "../../shared/web-bridge-methods";

function fixture() {
  const calls: { url: string; token: string | null; method?: string }[] = [];
  let settle: (() => void) | undefined;
  let wait: Promise<void> | undefined;
  let status = 200;
  const remote = (token: string) => ({
    ready: true,
    backend: {
      session: {
        authorized: (call: (token: string) => unknown) => call(token),
      },
      client: new Sub2ApiClient(
        "https://service.example",
        async (url, init) => {
          calls.push({
            url: String(url),
            token: new Headers(init?.headers).get("authorization"),
            method: init?.method,
          });
          await wait;
          return new Response(
            JSON.stringify(
              status === 200
                ? {
                    code: 0,
                    data:
                      init?.method === "DELETE"
                        ? { withdrawn: true }
                        : { version: 1, items: [] },
                  }
                : { code: status, message: "Service unavailable" },
            ),
            { status },
          );
        },
      ),
    },
  });
  const context = {
    activeAccount: { id: "a" },
    store: {},
    engine: {},
    remote: remote("account-a"),
    onAccountDeactivating(callback: () => void) {
      deactivate = callback;
      return () => {};
    },
    onAccountActivated(callback: () => void) {
      activate = callback;
      return () => {};
    },
  };
  let deactivate = () => {},
    activate = () => {};
  const handlers = new Map<string, (...args: any[]) => any>();
  registerPrivacyDataHandlers(
    (name, callback) => handlers.set(name, callback),
    context as unknown as AppContext,
  );
  return {
    context,
    calls,
    handlers,
    remote,
    invoke: (name: string, ...args: unknown[]) => handlers.get(name)!(...args),
    hold() {
      wait = new Promise<void>((resolve) => (settle = resolve));
    },
    release() {
      settle?.();
      wait = undefined;
    },
    deactivate: () => deactivate(),
    activate: () => activate(),
    status(value: number) {
      status = value;
    },
  };
}

test("registered Privacy methods use the captured authenticated client and real routes", async () => {
  const env = fixture();
  assert.equal(env.handlers.size, 5);
  assert.deepEqual(await env.invoke("feedbackHistory"), { items: [] });
  const id = "2a496130-1075-4fa0-8d26-8a27655a47c1";
  assert.deepEqual(await env.invoke("withdrawFeedback", id), {
    withdrawn: true,
  });
  assert.deepEqual(
    env.calls.map(({ url, token, method }) => [url, token, method]),
    [
      [
        "https://service.example/api/v1/claudex/feedback/history?limit=50",
        "Bearer account-a",
        "GET",
      ],
      [
        `https://service.example/api/v1/claudex/feedback/history/${id}`,
        "Bearer account-a",
        "DELETE",
      ],
    ],
  );
});

test("a pending real history request retires before sign-out waits, including reopening the same identities", async () => {
  const env = fixture();
  env.hold();
  const pending = env.invoke("feedbackHistory");
  env.deactivate();
  env.activate();
  env.release();
  await assert.rejects(pending, /retired account/);
  assert.deepEqual(await env.invoke("feedbackHistory"), { items: [] });
});

test("switching any account/store/engine/remote identity rejects late data without sending to the replacement", async () => {
  for (const key of ["activeAccount", "store", "engine", "remote"] as const) {
    const env = fixture();
    env.hold();
    const pending = env.invoke("feedbackHistory");
    (env.context as any)[key] = key === "remote" ? env.remote("account-b") : {};
    env.release();
    await assert.rejects(pending, /retired account/);
    assert.equal(env.calls.length, 1);
    assert.equal(env.calls[0].token, "Bearer account-a");
  }
});

test("unsupported services differ from authentication/server failures and signed-out requests fail", async () => {
  const env = fixture();
  env.status(404);
  assert.deepEqual((await env.invoke("privacyDataStatus")).feedback, {
    supported: false,
    reason: "unsupported-service",
  });
  for (const status of [401, 403, 500]) {
    env.status(status);
    await assert.rejects(env.invoke("privacyDataStatus"));
  }
  env.deactivate();
  await assert.rejects(env.invoke("feedbackHistory"), /Sign in again/);
});

test("Privacy calls execute on the owning runner and native extension mutations are absent on web", () => {
  for (const name of [
    "privacyDataStatus",
    "feedbackHistory",
    "withdrawFeedback",
    "uploadedFiles",
  ])
    assert.equal(webMethodKind(name), "remote-runner");
  for (const name of [
    "desktopExtensions",
    "desktopExtension",
    "saveDesktopExtension",
    "uninstallDesktopExtension",
  ])
    assert.equal(webMethodKind(name), "absent");
});
