import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  ConversationServicesContext,
  type ConversationServices,
} from "../../src/conversation/ConversationServices";
import GeneratedImageCard from "../../src/artifacts/GeneratedImageCard";
import { MessageAttachments } from "../../src/composer/Attachments";
import { ConversationSurface } from "../../src/mobile-conversation/ConversationSurface";
import { DocumentSurface } from "../../src/mobile-conversation/DocumentSurface";
import { ConversationBridge } from "../../src/mobile-conversation/bridge";
import { ReplyMark } from "../../src/transcript/TurnActivity";
import type {
  ConversationActionResult,
  ConversationEvent,
  ConversationRenderState,
} from "../../shared/mobile/conversation-contract";

const services: ConversationServices = {
  imagePreviewUnavailable: "Image preview unavailable",
  copyText: async () => {},
  attachmentPreview: async () => null,
  loadRemoteImage: async () => {
    throw Error("not available");
  },
  readGeneratedFile: async () => {
    throw Error("not available");
  },
  imageGenerationSnapshot: async () => null,
  viewedImageSnapshot: async () => null,
};
function environment() {
  const { window, document } = parseHTML(
    '<html><body><div id="root"></div></body></html>',
  );
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    ResizeObserver: globalThis.ResizeObserver,
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener,
  };
  Object.assign(globalThis, {
    window,
    document,
    getComputedStyle: () => ({
      paddingTop: "0px",
      paddingBottom: "0px",
      getPropertyValue: () => "0",
    }),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
  });
  const root = createRoot(document.getElementById("root")!);
  return {
    root,
    document,
    restore() {
      Object.assign(globalThis, previous);
    },
  };
}

function surfaceHarness() {
  const env = environment();
  const events: ConversationEvent[] = [];
  const bridge = new ConversationBridge((event) => events.push(event));
  bridge.setSession("surface-a");
  const state: ConversationRenderState = {
    version: 1,
    sessionId: "surface-a",
    revision: 1,
    theme: "light",
    conversation: {
      id: "conversation",
      title: "Cancellation fixture",
      mode: "chat",
      providerId: "fixture",
      model: "fixture",
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      turns: [
        {
          id: "turn",
          prompt: "Question",
          status: "completed",
          createdAt: 1,
          attachments: [],
          items: [
            {
              id: "reply",
              type: "agentMessage",
              text: "Answer [link](https://example.com/)",
            },
          ],
        },
      ],
    },
  };
  const click = async (selector: string) => {
    const control = env.document.querySelector(selector);
    assert.ok(control, selector);
    await act(async () => {
      control.dispatchEvent(
        new window.Event("click", { bubbles: true, cancelable: true }),
      );
    });
    return events.at(-1)! as { requestId: string };
  };
  const respond = async (
    reply: Partial<ConversationActionResult>,
    event = events.at(-1)! as { requestId: string },
  ) => {
    await act(async () => {
      bridge.result({
        version: 1,
        sessionId: state.sessionId,
        requestId: event.requestId,
        ok: true,
        ...reply,
      });
    });
  };
  return { ...env, events, bridge, state, click, respond };
}

test("real transcript Retry declines quietly and later success clears only its own failure", async () => {
  const env = surfaceHarness();
  const retry = '.message-actions button[aria-label="Retry"]';
  const link = '.markdown a[href="https://example.com/"]';
  const message = () =>
    env.document.querySelector('[role="alert"]')?.textContent;
  try {
    await act(async () =>
      env.root.render(
        createElement(ConversationSurface, {
          state: env.state,
          bridge: env.bridge,
          onApplied() {},
        }),
      ),
    );
    await env.click(retry);
    await env.respond({
      ok: false,
      cancelled: true,
      cancellationReason: "userDeclined",
    });
    assert.equal(message(), undefined);
    assert.equal(
      env.events.filter((event) => event.type === "retryResponse").length,
      1,
    );
    await env.click(retry);
    await env.respond({ ok: false, error: "Retry service failed" });
    assert.match(message()!, /Retry service failed/);
    await env.click(retry);
    await env.respond({
      ok: false,
      cancelled: true,
      cancellationReason: "userDeclined",
    });
    assert.match(message()!, /Retry service failed/);
    const retryRequest = await env.click(retry);
    await env.click(link);
    await env.respond({ ok: false, error: "Link failed" });
    await env.respond({}, retryRequest);
    assert.match(message()!, /Link failed/);
    await env.click(link);
    await env.respond({});
    assert.equal(message(), undefined);
    await env.click(retry);
    await env.respond({ ok: false, error: "Retry failed again" });
    assert.match(message()!, /Retry failed again/);
    await env.click(retry);
    await env.respond({});
    assert.equal(message(), undefined);
    await env.click(retry);
    await env.respond({
      ok: false,
      cancelled: true,
      error: "Submitted operation may still complete",
    });
    assert.match(message()!, /Submitted operation may still complete/);
  } finally {
    await act(async () => {
      env.bridge.dispose();
      env.root.unmount();
    });
    env.restore();
  }
});

test("document link decline is quiet, genuine errors remain, and local copy/image recovery is unchanged", async () => {
  const env = surfaceHarness();
  try {
    await act(async () =>
      env.root.render(
        createElement(DocumentSurface, {
          bridge: env.bridge,
          onApplied() {},
          state: {
            version: 1,
            sessionId: env.state.sessionId,
            revision: 1,
            theme: "light",
            document: {
              id: "doc",
              name: "doc.md",
              language: "markdown",
              content:
                "[link](https://example.com/)\n\n```js\nconst answer = 42;\n```\n\n![image](https://example.com/image.png)",
            },
          },
        }),
      ),
    );
    const link = '.markdown a[href="https://example.com/"]';
    await env.click(link);
    await env.respond({
      ok: false,
      cancelled: true,
      cancellationReason: "userDeclined",
    });
    assert.equal(env.document.querySelector('[role="alert"]'), null);
    await env.click(link);
    await env.respond({ ok: false, error: "Cannot open this link" });
    assert.match(
      env.document.querySelector('[role="alert"]')!.textContent!,
      /Cannot open this link/,
    );
    await env.click('.code-block [data-testid="code-block-copy"]');
    await env.respond({ ok: false, error: "Clipboard unavailable" });
    assert.equal(
      env.document.querySelector('[data-testid="code-block-copy"] .copy-status')
        ?.textContent,
      "Copy failed",
    );
    await env.click('.code-block [data-testid="code-block-copy"]');
    await env.respond({});
    assert.equal(
      env.document.querySelector('[data-testid="code-block-copy"] .copy-status')
        ?.textContent,
      "Copied",
    );
    assert.match(
      env.document.querySelector('[role="alert"]')!.textContent!,
      /Cannot open this link/,
    );
    await env.click(".markdown-image-placeholder button");
    await env.respond({ ok: false, error: "Image unavailable" });
    assert.match(
      env.document.querySelector(".markdown-image-error")!.textContent!,
      /This image didn’t load/,
    );
    await env.click(".markdown-image-placeholder button");
    await env.respond({ result: "data:image/png;base64,AAAA" });
    assert.ok(env.document.querySelector("img.markdown-image"));
    await env.click(link);
    await env.respond({});
    assert.equal(env.document.querySelector('[role="alert"]'), null);
  } finally {
    await act(async () => {
      env.bridge.dispose();
      env.root.unmount();
    });
    env.restore();
  }
});

test("pending old-session cancellation cannot create an error in a replacement surface", async () => {
  const env = surfaceHarness();
  const render = () =>
    createElement(ConversationSurface, {
      state: env.state,
      bridge: env.bridge,
      onApplied() {},
    });
  try {
    await act(async () => env.root.render(render()));
    const old = await env.click('.message-actions button[aria-label="Retry"]');
    await act(async () => {
      env.bridge.setSession("surface-b");
      env.state = { ...env.state, sessionId: "surface-b", revision: 2 };
      env.root.render(render());
    });
    assert.equal(env.document.querySelector('[role="alert"]'), null);
    assert.equal(
      env.bridge.result({
        version: 1,
        sessionId: "surface-a",
        requestId: old.requestId,
        ok: false,
        error: "Late old failure",
      }),
      false,
    );
    await act(async () => env.bridge.dispose());
    assert.equal(env.document.querySelector('[role="alert"]'), null);
  } finally {
    await act(async () => {
      env.bridge.dispose();
      env.root.unmount();
    });
    env.restore();
  }
});

test("completed ReplyMark keeps the canonical still star and removes every streaming marker", async () => {
  const env = environment();
  try {
    await act(async () =>
      env.root.render(
        createElement(ReplyMark, { streaming: true, done: false }),
      ),
    );
    assert.ok(env.document.querySelector(".response-stream-mark .spark-mark"));
    await act(async () =>
      env.root.render(
        createElement(ReplyMark, { streaming: false, done: true }),
      ),
    );
    assert.equal(env.document.querySelector(".spark-mark"), null);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 140));
    });
    assert.equal(
      env.document.querySelectorAll(".response-end-mark > svg.star").length,
      1,
    );
    assert.equal(
      env.document.querySelector(
        ".response-stream-mark, .spark-mark, .spark-mark-steps, .code-spinner, animate, animateTransform",
      ),
      null,
    );
    await act(async () =>
      env.root.render(
        createElement(ReplyMark, { streaming: false, done: true }),
      ),
    );
    assert.equal(
      env.document.querySelectorAll(".response-end-mark > svg.star").length,
      1,
    );
  } finally {
    await act(async () => env.root.unmount());
    env.restore();
  }
});
test("completed image tool mounts passive effect with no desktop bridge", async () => {
  const env = environment();
  let called = 0;
  try {
    assert.equal(
      (window as unknown as { desktop?: unknown }).desktop,
      undefined,
    );
    await act(async () =>
      env.root.render(
        createElement(
          ConversationServicesContext.Provider,
          {
            value: {
              ...services,
              imageGenerationSnapshot: async () => {
                called++;
                return null;
              },
            },
          },
          createElement(GeneratedImageCard, {
            savedPath: "/generated/image.png",
            onArtifact() {},
          }),
        ),
      ),
    );
    assert.equal(called, 1);
    assert.match(
      env.document.body.textContent ?? "",
      /Image preview unavailable/,
    );
  } finally {
    await act(async () => env.root.unmount());
    env.restore();
  }
});
test("attachment effect initially returns null then later native media renders a thumbnail", async () => {
  const env = environment();
  const attachments = [
    {
      id: "image",
      name: "image.png",
      path: "/image.png",
      kind: "image" as const,
      size: 10,
    },
  ];
  const render = (url: string | null) =>
    createElement(
      ConversationServicesContext.Provider,
      { value: { ...services, attachmentPreviewSync: () => url } },
      createElement(MessageAttachments, { attachments }),
    );
  try {
    await act(async () => env.root.render(render(null)));
    assert.equal(env.document.querySelector("img"), null);
    await act(async () =>
      env.root.render(render("data:image/png;base64,AAAA")),
    );
    assert.equal(
      env.document.querySelector("img")?.getAttribute("src"),
      "data:image/png;base64,AAAA",
    );
    await act(async () => env.root.render(render(null)));
    assert.equal(env.document.querySelector("img"), null);
  } finally {
    await act(async () => env.root.unmount());
    env.restore();
  }
});

test("Download all admits one native batch and reports only completed saves on cancellation", async () => {
  const { DownloadAllButton } =
    await import("../../src/artifacts/GeneratedFileCard");
  const env = environment();
  const calls: string[][] = [];
  const notices: string[] = [];
  let finish!: (count: number) => void;
  try {
    await act(async () =>
      env.root.render(
        createElement(
          ConversationServicesContext.Provider,
          {
            value: {
              ...services,
              downloadArtifact: async () => {
                throw Error("Must not automate a second JS download request");
              },
              downloadArtifacts: (artifacts) => {
                calls.push(artifacts.map((artifact) => artifact.id));
                return new Promise<number>((resolve) => {
                  finish = resolve;
                });
              },
            },
          },
          createElement(DownloadAllButton, {
            files: ["one", "two"].map((id) => ({
              id,
              name: `${id}.txt`,
              path: `/${id}.txt`,
              language: "text",
              content: id,
              operation: "create" as const,
              state: "ready" as const,
            })),
            onNotify: (message) => notices.push(message),
          }),
        ),
      ),
    );
    const button = env.document.querySelector("button")!;
    await act(async () =>
      button.dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.deepEqual(calls, [
      ["generated:one:undefined", "generated:two:undefined"],
    ]);
    assert.equal(button.hasAttribute("disabled"), true);
    await act(async () =>
      button.dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.equal(calls.length, 1);
    await act(async () => finish(1));
    assert.deepEqual(notices, ["Saved 1 file"]);
    assert.equal(button.hasAttribute("disabled"), false);
  } finally {
    await act(async () => env.root.unmount());
    env.restore();
  }
});
