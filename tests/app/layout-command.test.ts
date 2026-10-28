import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import type { AppController } from "../../src/app/AppContext";
import type { LayoutCommand } from "../../shared/window-layout";
import { runLayoutCommand } from "../../src/split-view/layout-command";
import {
  resetSplitState,
  setSplitState,
  splitState,
} from "../../src/split-view/split-state";

test("renderer layout commands inspect, split, focus, close owned panes and change the sidebar safely", async (context) => {
  const { window } = parseHTML("<html><body></body></html>");
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const popouts: string[] = [];
  const opened: unknown[][] = [];
  const values = {
    window: Object.assign(window, {
      desktop: {
        windowLayoutState: async () => ({
          popoutSessionIds: [...popouts],
          visibleSessionIds: [...popouts],
          otherPopoutCount: 2,
        }),
        openConversationWindow: async (...args: unknown[]) => {
          opened.push(args);
        },
      },
    }),
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
  };
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  context.after(() => {
    resetSplitState();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  resetSplitState();
  setSplitState({ maxColumns: 3, shown: true });
  let toggled = 0;
  const app = {
    activeId: "c-1",
    mode: "code",
    page: "chat",
    snapshot: {
      conversations: [
        { id: "c-1", mode: "code" },
        { id: "c-2", mode: "code" },
        { id: "c-3", mode: "code" },
      ],
    },
    sidebarView: {
      open: true,
      narrow: false,
      toggle: () => {
        toggled++;
      },
    },
    openConversation: () => {},
  } as unknown as AppController;
  let request = 0;
  const run = (
    kind: LayoutCommand["kind"],
    extra: Partial<LayoutCommand> = {},
  ) =>
    runLayoutCommand(
      {
        requestId: `r-${++request}`,
        kind,
        deadline: Date.now() + 10000,
        mainWindowHidden: false,
        callerSessionId: "c-1",
        ...extra,
      },
      app,
    );
  const initial = await run("get_layout");
  assert.equal(initial.outcome, "done");
  assert.equal(initial.layout?.caller.primary, true);
  assert.equal(initial.layout?.otherPopoutCount, 2);
  assert.equal(
    (await run("focus", { targetSessionId: "c-2", deadline: 0 })).reason,
    "expired",
  );
  assert.equal(
    (
      await run("open_in_split", {
        callerSessionId: "absent",
        targetSessionId: "c-2",
      })
    ).reason,
    "caller_not_visible",
  );
  assert.equal(
    (
      await run("open_in_split", {
        mainWindowHidden: true,
        targetSessionId: "c-2",
      })
    ).reason,
    "window_hidden",
  );
  const dialog = window.document.createElement("div");
  dialog.setAttribute("role", "dialog");
  window.document.body.append(dialog);
  assert.equal(
    (await run("open_in_split", { targetSessionId: "c-2" })).reason,
    "dialog_open",
  );
  dialog.remove();
  assert.equal((await run("open_in_split")).reason, "missing_target");
  const split = await run("open_in_split", { targetSessionId: "c-2" });
  assert.equal(split.outcome, "done");
  assert.equal(split.paneIndex, 1);
  assert.equal(
    splitState().focus,
    0,
    "opening does not steal the person's focus",
  );
  assert.equal(
    (await run("open_in_split", { targetSessionId: "c-2" })).reason,
    "already_in_pane",
  );
  assert.equal(
    (
      await run("close_split", {
        callerSessionId: "c-2",
        targetSessionId: "c-2",
      })
    ).reason,
    "not_opened_by_you",
  );
  assert.equal(
    (await run("focus", { targetSessionId: "c-2" })).reason,
    "focused_pane",
  );
  setSplitState({ focus: 0 });
  assert.equal(
    (await run("close_split", { targetSessionId: "c-2" })).outcome,
    "done",
  );
  assert.equal(splitState().panes.length, 0);
  const collapsed = await run("set_sidebar_collapsed", { collapsed: true });
  assert.equal(collapsed.outcome, "done");
  assert.equal(collapsed.layout?.sidebarCollapsed, true);
  assert.equal(toggled, 1);
  assert.equal(
    (await run("open_in_window", { targetSessionId: "c-3" })).outcome,
    "done",
  );
  assert.deepEqual(opened, [["c-3", undefined, { showInactive: true }]]);
  popouts.push("c-3");
  assert.equal(
    (await run("open_in_window", { targetSessionId: "c-3" })).reason,
    "already_in_window",
  );
});
