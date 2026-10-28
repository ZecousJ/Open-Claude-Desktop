import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import type { RoutineDraft } from "../../src/collections/routines/routine-draft";

const surface = Object.getOwnPropertyDescriptor(
  globalThis,
  "__CLAUDEX_SURFACE__",
);
Object.defineProperty(globalThis, "__CLAUDEX_SURFACE__", {
  configurable: true,
  value: "web",
});
const { RoutineSettings } =
  await import("../../src/collections/routines/RoutineSettings");
const { newDraft } =
  await import("../../src/collections/routines/routine-draft");
if (surface) Object.defineProperty(globalThis, "__CLAUDEX_SURFACE__", surface);
else Reflect.deleteProperty(globalThis, "__CLAUDEX_SURFACE__");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("notification permission respects same-location revisions, the newest request and the save lock", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(window, "top", { configurable: true, value: window });
  window.desktop = {
    routineCapabilities: async () => ({
      remote: true,
      email: true,
      slack: true,
    }),
  } as never;
  const requests: ReturnType<typeof deferred<NotificationPermission>>[] = [];
  const globals = {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
    Notification: {
      permission: "default",
      requestPermission: () => {
        const request = deferred<NotificationPermission>();
        requests.push(request);
        return request.promise;
      },
    },
  };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const draft: RoutineDraft = {
    ...newDraft(Date.now(), undefined, "cowork"),
    id: "synthetic-notification-task",
    executionLocation: "remote",
    notifyOnCompletion: { push: false, email: false, slack: false },
  };
  const patches: Partial<RoutineDraft>[] = [];
  const render = (value = draft, disabled = false) =>
    act(async () =>
      root.render(
        createElement(RoutineSettings, {
          draft: value,
          disabled,
          onChange: (patch) => patches.push(patch),
        }),
      ),
    );
  const click = (selector: string) =>
    act(async () => {
      document
        .querySelector(selector)!
        .dispatchEvent(
          new window.Event("click", { bubbles: true, cancelable: true }),
        );
    });
  const notify =
    '[role="switch"][aria-label="Notify me when this task finishes"]';
  try {
    await render();
    await click(".routine-advanced-trigger");
    // The web's Advanced settings are tabs; the switch is under Notifications.
    await click('.routine-advanced-tabs [role="tab"]:last-child');
    await click(notify);
    assert.equal(requests.length, 1);
    // A same-location update to saved channels also expires the old request.
    await render({
      ...draft,
      notifyOnCompletion: { push: false, email: true, slack: true },
    });
    await act(async () => requests[0].resolve("granted"));
    assert.deepEqual(patches, []);

    await render();
    await click(notify);
    await click(notify);
    assert.equal(requests.length, 3);
    await act(async () => requests[2].resolve("granted"));
    assert.deepEqual(patches, [
      { notifyOnCompletion: { push: true, email: false, slack: false } },
    ]);
    await act(async () => requests[1].resolve("denied"));
    assert.equal(
      document.querySelector('[role="alert"]'),
      null,
      "an obsolete refusal cannot replace the latest granted result",
    );
    assert.equal(patches.length, 1);

    await click(notify);
    assert.equal(requests.length, 4);
    await render(draft, true);
    await act(async () => requests[3].resolve("granted"));
    assert.equal(
      patches.length,
      1,
      "permission granted during save cannot alter the submitted draft",
    );
    assert.equal(
      document.querySelector<HTMLButtonElement>(notify)!.disabled,
      true,
    );
  } finally {
    await act(async () => root.unmount());
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
