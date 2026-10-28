import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { AppContext, type AppController } from "../../src/app/AppContext";
import type { Conversation } from "../../shared/types";
import type { SessionLoop } from "../../shared/session-loops";

test("the rail's Background tasks card lists the session's scheduled prompts first, with the next run", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const now = Date.now();
  const loops: SessionLoop[] = [
    {
      id: "later",
      conversationId: "c1",
      prompt: "print helloworld again",
      cron: "44 18 23 10 *",
      recurring: false,
      createdAt: now,
      nextRunAt: now + 17 * 60_000 + 30_000,
    },
    {
      id: "soon",
      conversationId: "c1",
      prompt: "print helloworld",
      cron: "34 18 23 10 *",
      recurring: false,
      createdAt: now,
      // Half a minute of slack: a slow run must still read 7m.
      nextRunAt: now + 7 * 60_000 + 30_000,
    },
  ];
  const stopped: string[] = [];
  window.desktop = new Proxy(
    {
      listSessionLoops: async () =>
        loops.filter((loop) => !stopped.includes(loop.id)),
      stopSessionLoop: async (_id: string, loopId: string) => {
        stopped.push(loopId);
        return true;
      },
    } as Record<string, unknown>,
    {
      get: (target, key) =>
        key in target
          ? target[key as string]
          : String(key).startsWith("on")
            ? () => () => {}
            : async () => undefined,
    },
  ) as never;
  Object.assign(globalThis, {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { SessionRail } = await import("../../src/session-rail/SessionRail");
  const conversation = {
    id: "c1",
    title: "Background",
    mode: "code",
    createdAt: 1000,
    updatedAt: 1000,
    pinned: false,
    archived: false,
    providerId: "p",
    model: "m",
    cwd: "/tmp/session",
    turns: [],
  } as unknown as Conversation;
  const app = {
    snapshot: { settings: {}, conversations: [conversation] },
    activeTerminals: [],
    setPanel: () => {},
    report: (error: unknown) => {
      throw error;
    },
    panel: null,
  } as unknown as AppController;
  const root = createRoot(document.querySelector("main")!);
  try {
    await act(async () => {
      root.render(
        createElement(
          AppContext.Provider,
          { value: app },
          createElement(SessionRail, { conversation }),
        ),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const card = document.querySelector(
      '[data-rail-section="backgroundTasks"]',
    );
    assert.ok(card, "Background tasks card");
    const text = card.textContent ?? "";
    assert.ok(
      text.indexOf("print helloworld") < text.indexOf("print helloworld again"),
      text,
    );
    const rows = [...card.querySelectorAll(".rail-row")];
    assert.equal(rows[0].getAttribute("title"), "34 18 23 10 *");
    assert.match(rows[0].textContent ?? "", /Next 7m/);
    const stop = rows[0].querySelector(
      'button[aria-label="Stop this scheduled prompt"]',
    ) as HTMLButtonElement;
    await act(async () => {
      stop.dispatchEvent(new window.Event("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.deepEqual(stopped, ["soon"]);
  } finally {
    await act(async () => root.unmount());
  }
});
