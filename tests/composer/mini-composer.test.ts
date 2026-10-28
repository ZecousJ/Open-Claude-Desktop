import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { act, createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { Attachment } from "../../shared/types";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { MiniTaskComposer } from "../../src/cowork/MiniTaskComposer";
import { MiniComposerAttachments } from "../../src/cowork/MiniComposerAttachments";
import { MiniComposerControls } from "../../src/cowork/MiniComposerControls";

const attachment = (name = "notes.txt"): Attachment => ({
  id: name,
  name,
  kind: "text",
  path: `/${name}`,
  size: 1,
});

// Compact files and circular actions.
test("mini attachments show compact names, previews, uploading and removable errors", () => {
  const html = renderToStaticMarkup(
    createElement(MiniComposerAttachments, {
      files: [
        {
          id: "1",
          name: "photo.png",
          status: "uploading",
          preview: "blob:photo",
        },
        { id: "2", name: "failed.txt", status: "error" },
        { id: "3", name: "ready.txt", status: "done" },
      ],
      onRemove: () => {},
    }),
  );
  assert.match(html, /class="mini-composer-attachments"/);
  assert.equal((html.match(/class="mini-composer-chip"/g) ?? []).length, 3);
  assert.match(html, /aria-label="Preview image"/);
  assert.match(html, /<img src="blob:photo" alt=""/);
  assert.match(html, /role="status" aria-label="Uploading"/);
  assert.match(html, /class="mini-composer-file-error">!</);
  assert.equal((html.match(/aria-label="Remove file"/g) ?? []).length, 3);
  assert.doesNotMatch(html, /attachment-thumbnail|attachment-card/);
});

test("mini actions use the 32px circle, upload status, and 68px running capsule", () => {
  const render = (running: boolean, hasContent: boolean, waiting = false) =>
    renderToStaticMarkup(
      createElement(MiniComposerControls, {
        running,
        hasContent,
        waiting,
        disabled: false,
        onSend: () => {},
      }),
    );
  const idle = render(false, false);
  assert.match(idle, /width:32px/);
  assert.match(idle, /aria-label="Send message" disabled=""/);
  assert.match(
    render(false, true, true),
    /role="status" aria-label="Waiting for uploads"/,
  );
  const stop = render(true, false);
  assert.match(stop, /aria-label="Stop response"/);
  assert.match(stop, /r="15.25" pathLength="12"/);
  assert.doesNotMatch(stop, /aria-label="Send message"/);
  const grouped = render(true, true);
  assert.match(grouped, /data-grouped="true" style="width:68px;gap:4px"/);
  assert.match(grouped, /pathLength="20"/);
  assert.match(grouped, /aria-label="Send message"/);
});

test("a draft's action is the brand ArrowUp Start task button, busy while it starts", () => {
  const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(MiniComposerControls, {
        start: true,
        hasContent: true,
        disabled: false,
        onSend: () => {},
        ...props,
      }),
    );
  const ready = render({});
  assert.match(ready, /class="send-button"/);
  assert.match(ready, /aria-label="Start task"/);
  assert.match(ready, /data-icon="ArrowUp"/);
  assert.doesNotMatch(ready, /Send message|width:32px/);
  assert.match(render({ hasContent: false }), /disabled=""/);
  const busy = render({ busy: true, disabled: true });
  assert.match(busy, /aria-busy="true"/);
  assert.match(busy, /mini-composer-spinner/);
});

async function mount(context: TestContext, text = "Plan it") {
  const { window, document } = parseHTML(
    '<html data-motion="reduced"><body><main></main></body></html>',
  );
  (document as unknown as { oninput: null }).oninput = null;
  const uploads = new Map<
    string,
    {
      resolve: (value: Attachment) => void;
      reject: (error: Error) => void;
    }
  >();
  Object.assign(window, {
    desktop: {
      modelCatalog: async () => null,
      addAttachmentData: (name: string) =>
        new Promise<Attachment>((resolve, reject) => {
          uploads.set(name, { resolve, reject });
        }),
    },
  });
  const globals = { window, document, IS_REACT_ACT_ENVIRONMENT: true };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  context.after(async () => {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const starts: Attachment[][] = [];
  const errors: unknown[] = [];
  const controller = {
    snapshot: {
      settings: { providers: [], effort: "medium", mcpServers: {} },
      projects: [],
      platform: "darwin",
    },
    policy: { attachments: { types: ["txt", "png"] } },
    report: (error: unknown) => errors.push(error),
    notify: () => {},
  } as unknown as AppController;
  function Composer() {
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    return createElement(
      AppContext.Provider,
      { value: controller },
      createElement(MiniTaskComposer, {
        placeholder: "What else can I work on?",
        text,
        setText: () => {},
        attachments,
        setAttachments,
        focus: false,
        unsafe: false,
        starting: false,
        onStart: () => starts.push(attachments),
        permission: false,
        providerId: "p",
        model: "m",
        onModel: () => {},
      }),
    );
  }
  await act(async () => root.render(createElement(Composer)));
  return {
    document,
    uploads,
    starts,
    errors,
    drop: async (name: string) => {
      const event = new window.Event("drop", {
        bubbles: true,
        cancelable: true,
      });
      Object.assign(event, {
        dataTransfer: {
          types: ["Files"],
          files: [
            {
              name,
              type: "text/plain",
              size: 1,
              arrayBuffer: async () => new ArrayBuffer(1),
            },
          ],
        },
      });
      await act(async () => {
        document.querySelector("fieldset")!.dispatchEvent(event);
      });
    },
    click: async (label: string) => {
      await act(async () => {
        document
          .querySelector(`button[aria-label="${label}"]`)!
          .dispatchEvent(new window.Event("click", { bubbles: true }));
      });
    },
    enter: async (isComposing = false) => {
      const event = new window.Event("keydown", {
        bubbles: true,
        cancelable: true,
      });
      Object.assign(event, { key: "Enter", isComposing });
      await act(async () => {
        document.querySelector("textarea")!.dispatchEvent(event);
      });
    },
  };
}

test("sending during upload queues once and submits the finished attachment", async (context) => {
  const mounted = await mount(context);
  await mounted.drop("notes.txt");
  assert.ok(mounted.document.querySelector('[aria-label="Uploading"]'));
  assert.equal(
    mounted.document.querySelector('[aria-label="Waiting for uploads"]'),
    null,
  );
  await mounted.click("Start task");
  await mounted.click("Start task");
  assert.ok(
    mounted.document.querySelector('[aria-label="Waiting for uploads"]'),
  );
  assert.equal(mounted.starts.length, 0);
  await act(async () =>
    mounted.uploads.get("notes.txt")!.resolve(attachment()),
  );
  assert.deepEqual(mounted.starts, [[attachment()]]);
  assert.equal(
    mounted.document.querySelector('[aria-label="Uploading"]'),
    null,
  );
  assert.equal(
    mounted.document.querySelector('[aria-label="Waiting for uploads"]'),
    null,
  );
});

test("removing an uploading chip cancels queued submission and ignores late completion", async (context) => {
  const mounted = await mount(context);
  await mounted.drop("notes.txt");
  await mounted.click("Start task");
  await mounted.click("Remove file");
  assert.equal(
    mounted.document.querySelector('[aria-label="Waiting for uploads"]'),
    null,
  );
  await act(async () =>
    mounted.uploads.get("notes.txt")!.resolve(attachment()),
  );
  assert.equal(mounted.starts.length, 0);
  assert.equal(mounted.document.querySelector(".mini-composer-chip"), null);
});

test("a failed upload remains removable and does not auto-submit the queued prompt", async (context) => {
  const mounted = await mount(context);
  await mounted.drop("notes.txt");
  await mounted.click("Start task");
  await act(async () =>
    mounted.uploads.get("notes.txt")!.reject(new Error("upload failed")),
  );
  assert.equal(mounted.starts.length, 0);
  assert.equal(mounted.errors.length, 1);
  assert.equal(
    mounted.document.querySelector(".mini-composer-file-error")?.textContent,
    "!",
  );
  assert.equal(
    mounted.document.querySelector('[aria-label="Waiting for uploads"]'),
    null,
  );
  await mounted.click("Remove file");
  await mounted.click("Start task");
  assert.deepEqual(mounted.starts, [[]]);
});

test("attachment-only Enter waits for every upload and respects composition", async (context) => {
  const mounted = await mount(context, "");
  await mounted.drop("first.txt");
  await mounted.drop("second.txt");
  await mounted.enter(true);
  assert.equal(
    mounted.document.querySelector('[aria-label="Waiting for uploads"]'),
    null,
  );
  await mounted.enter();
  assert.ok(
    mounted.document.querySelector('[aria-label="Waiting for uploads"]'),
  );
  await act(async () =>
    mounted.uploads.get("second.txt")!.resolve(attachment("second.txt")),
  );
  assert.equal(mounted.starts.length, 0);
  await act(async () =>
    mounted.uploads.get("first.txt")!.resolve(attachment("first.txt")),
  );
  assert.deepEqual(mounted.starts, [
    [attachment("second.txt"), attachment("first.txt")],
  ]);
});
