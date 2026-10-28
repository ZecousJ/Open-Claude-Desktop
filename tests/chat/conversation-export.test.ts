import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Conversation } from "../../shared/types";
import { exportConversation } from "../../src/conversation/conversation-export";
import { currentToasts, dismissAllToasts } from "../../src/ui/toast-store";
import { ToastMessage } from "../../src/ui/Toaster";

test("Code export has progress, a revealable local path, cancellation and the official failure copy", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const savedNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  const revealed: string[] = [];
  let result: string | null = "/Downloads/session.zip";
  let failure = false;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: "MacIntel" },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      desktop: {
        exportConversation: async () => {
          if (failure) throw Error("disk full");
          return result;
        },
        revealConversationExport: async (file: string) => {
          revealed.push(file);
          return true;
        },
      },
    },
  });
  const errors: unknown[] = [];
  const conversation = { id: "session", mode: "code" } as Conversation;
  const active = () => currentToasts().filter((toast) => !toast.closing);
  try {
    const pending = exportConversation(conversation, (error) =>
      errors.push(error),
    );
    assert.equal(active()[0].message, "Exporting session…");
    await pending;
    assert.equal(active().length, 1);
    const toast = active()[0];
    assert.equal(toast.message, "Session exported to /Downloads/session.zip");
    assert.equal(
      toast.inlineAction?.title,
      "Show in Finder: /Downloads/session.zip",
    );
    const html = renderToStaticMarkup(createElement(ToastMessage, { toast }));
    assert.match(html, /Session exported to <button[^>]*toast-inline-link/);
    assert.match(html, />\/Downloads\/session.zip<\/button>/);
    toast.inlineAction!.onSelect();
    await Promise.resolve();
    assert.deepEqual(revealed, ["/Downloads/session.zip"]);
    dismissAllToasts();
    result = null;
    await exportConversation(conversation, (error) => errors.push(error));
    assert.deepEqual(active(), []);
    failure = true;
    await exportConversation(conversation, (error) => errors.push(error));
    assert.equal(
      (errors[0] as Error).message,
      "Failed to export session. You can try again.",
    );
    assert.deepEqual(active(), []);
  } finally {
    dismissAllToasts();
    context.mock.timers.reset();
    if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (savedNavigator)
      Object.defineProperty(globalThis, "navigator", savedNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});
