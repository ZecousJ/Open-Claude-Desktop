import test, { before } from "node:test";
import assert from "node:assert/strict";
import { act, createElement, type ComponentProps } from "react";
import { parseHTML } from "linkedom";
import { ArtifactChrome } from "../../src/artifacts/ArtifactChrome";
import { NativePopout } from "../../src/artifacts/popout-document";
import { renderToStaticMarkup } from "react-dom/server";
import { popoutChrome } from "../../electron/artifacts/artifact-popout-page";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";

before(() => preloadMarkdownRenderer());

test("title menu follows rename, duplicate, window and report capabilities", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const globals = {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: () => ({ getPropertyValue: () => "0" }),
    CSS: { escape: (value: string) => value },
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
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
  let reports = "open";
  Object.assign(window, {
    desktop: {
      artifactReportsState: async () => reports,
      reportArtifact: async () => {},
    },
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  let finish: () => void = () => {};
  let copies = 0;
  const errors: unknown[] = [];
  const base: ComponentProps<typeof ArtifactChrome> = {
    artifact: {
      id: "card",
      name: "Card",
      language: "markdown",
      content: "# Card",
    },
    expanded: false,
    onExpand() {},
    onClose() {},
    onRefresh() {},
    onError: (error) => errors.push(error),
    onDuplicate: () => {
      copies++;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  };
  const render = async (props: Partial<typeof base> = {}) => {
    await act(async () => {
      root.render(createElement(ArtifactChrome, { ...base, ...props }));
    });
  };
  const click = async (selector: string) => {
    const button = document.querySelector<HTMLButtonElement>(selector);
    assert.ok(button, selector);
    await act(async () => {
      button.click();
    });
  };
  const item = (name: string) =>
    document.querySelector<HTMLButtonElement>(
      `[data-testid="frame-title-menu-${name}"]`,
    )!;
  try {
    await render({
      onRename: null,
      renameDisabledReason: "View only",
      duplicateDisabledReason: "View only",
      duplicateLabel: "Duplicate Version 1",
      openInWebAsTab: true,
    });
    await click(".artifact-title-options");
    assert.equal(item("rename").disabled, true);
    assert.equal(item("rename").getAttribute("aria-description"), "View only");
    assert.equal(item("duplicate").disabled, true);
    assert.equal(
      item("duplicate").textContent?.replace(/[\uE000-\uF8FF]/g, ""),
      "Duplicate Version 1",
    );
    assert.equal(
      item("duplicate").getAttribute("aria-description"),
      "View only",
    );
    assert.match(
      document
        .querySelector(".artifact-title-menu")!
        .textContent?.replace(/[\uE000-\uF8FF]/g, ""),
      /Open in new tab/,
    );
    assert.ok(
      item("report"),
      "a private artifact can be reported when the service accepts reports",
    );
    assert.equal(item("share").disabled, true);
    assert.ok(item("permissions"));
    assert.ok(item("permissions").querySelector("[data-icon='Lock']"));
    assert.equal(item("chat").getAttribute("role"), "menuitemcheckbox");
    assert.equal(item("chat").getAttribute("aria-checked"), "true");
    const order = [
      ...document.querySelectorAll(".artifact-title-menu > button"),
    ].map((button) => button.getAttribute("data-testid"));
    assert.ok(
      order.indexOf("frame-title-menu-share") <
        order.indexOf("frame-title-menu-permissions"),
    );
    assert.ok(
      order.indexOf("frame-title-menu-comments") <
        order.indexOf("frame-title-menu-expand"),
    );
    assert.ok(
      order.indexOf("frame-title-menu-expand") <
        order.indexOf("frame-title-menu-chat"),
    );
    await render({ onRename: async () => {}, duplicateBusy: true });
    assert.equal(item("rename").disabled, false);
    assert.equal(item("duplicate").disabled, true);
    await render();
    assert.equal(
      item("rename").disabled,
      true,
      "no metadata provider means no rename handler",
    );
    await click('[data-testid="frame-title-menu-duplicate"]');
    assert.equal(copies, 1);
    await click(".artifact-title-options");
    assert.equal(
      item("duplicate").disabled,
      true,
      "busy until the asynchronous copy finishes",
    );
    await act(async () => {
      finish();
    });
    assert.equal(item("duplicate").disabled, false);
    await render({ onDuplicate: undefined });
    assert.equal(item("duplicate"), null);
    assert.doesNotMatch(
      document
        .querySelector(".artifact-title-menu")!
        .textContent?.replace(/[\uE000-\uF8FF]/g, ""),
      /Pop out/,
    );
    await render({ onPopOut: async () => {} });
    assert.match(
      document
        .querySelector(".artifact-title-menu")!
        .textContent?.replace(/[\uE000-\uF8FF]/g, ""),
      /Pop out/,
    );
    let expands = 0;
    await render({
      expanded: true,
      onExpand: () => {
        expands++;
      },
    });
    if (!document.querySelector(".artifact-title-menu"))
      await click(".artifact-title-options");
    assert.equal(item("chat").getAttribute("aria-checked"), "false");
    assert.match(
      item("expand").textContent?.replace(/[\uE000-\uF8FF]/g, ""),
      /Collapse/,
    );
    assert.equal(
      document
        .querySelector(".artifact-chat-button")
        ?.textContent?.replace(/[\uE000-\uF8FF]/g, ""),
      "Show chat",
    );
    await click('[data-testid="frame-title-menu-chat"]');
    assert.equal(expands, 1);
    assert.equal(document.querySelector(".artifact-title-menu"), null);
    await click(".artifact-title-options");
    await click('[data-testid="frame-title-menu-expand"]');
    assert.equal(expands, 2);
    Object.assign(window.desktop, {
      artifactDataUsage: async () => ({
        bytes: 2048,
        maxBytes: 20 * 1024 * 1024,
      }),
    });
    await render({ artifact: { ...base.artifact, language: "html" } });
    await click(".artifact-title-options");
    const storage = document.querySelector<HTMLButtonElement>(
      '[data-testid="frame-title-menu-storage"]',
    );
    assert.ok(storage);
    await act(async () => storage.click());
    assert.match(
      document
        .querySelector(".artifact-storage-lines")!
        .textContent?.replace(/[\uE000-\uF8FF]/g, ""),
      /Database storage limit/,
    );
    assert.match(
      document
        .querySelector(".artifact-storage-lines")!
        .textContent?.replace(/[\uE000-\uF8FF]/g, ""),
      /2 kB of 21 MB/,
    );
    let projectCopies = 0;
    await render({
      onCopyToProject: async () => {
        projectCopies++;
        return true;
      },
    });
    if (!document.querySelector(".artifact-title-menu"))
      await click(".artifact-title-options");
    assert.ok(
      ![...document.querySelectorAll(".artifact-title-menu > button")].some(
        (button) =>
          button.textContent?.replace(/[\uE000-\uF8FF]/g, "") ===
          "Copy to project",
      ),
    );
    const copy = [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".artifact-title-menu button",
      ),
    ].find(
      (button) =>
        button.textContent?.replace(/[\uE000-\uF8FF]/g, "") === "Copy",
    );
    assert.ok(copy);
    await act(async () => copy.click());
    const project = [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".artifact-export-submenu button",
      ),
    ].find(
      (button) =>
        button.textContent?.replace(/[\uE000-\uF8FF]/g, "") ===
        "Copy to project",
    );
    assert.ok(project);
    await act(async () => project.click());
    assert.equal(projectCopies, 1);
    await act(async () => {
      root.unmount();
    });
    reports = "none";
    const next = createRoot(document.querySelector("main")!);
    await act(async () => {
      next.render(createElement(ArtifactChrome, base));
    });
    await click(".artifact-title-options");
    assert.equal(item("report"), null);
    await act(async () => {
      next.unmount();
    });
    assert.deepEqual(errors, []);
  } finally {
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});

test("native pop-outs render Markdown, tables and source without interpreting source as HTML", () => {
  const nativePopoutMarkup = (
    artifact: ComponentProps<typeof NativePopout>["artifact"],
    imageUrl?: string,
  ) =>
    renderToStaticMarkup(createElement(NativePopout, { artifact, imageUrl }));
  const artifact = {
    id: "file",
    name: "File",
    language: "markdown",
    content: "# Heading",
  };
  assert.match(nativePopoutMarkup(artifact), /<h1>Heading<\/h1>/);
  assert.match(
    nativePopoutMarkup({
      ...artifact,
      language: "csv",
      content: "Name,Value\nOne,2",
    }),
    /<table[^]*<th>Name<\/th>[^]*<td>2<\/td>/,
  );
  const code = nativePopoutMarkup({
    ...artifact,
    language: "text",
    content: '<script>alert("x")</script>',
  });
  assert.doesNotMatch(code, /<script>/);
  assert.match(code, /&lt;script/);
  assert.match(
    nativePopoutMarkup(
      { ...artifact, blob: true, mime: "image/png", language: "image" },
      "data:image/png;base64,YQ==",
    ),
    /<img[^]*data:image\/png;base64,YQ==/,
  );
});

test("binary pop-outs can download without offering Copy as Markdown", () => {
  const html = popoutChrome({
    title: "Image",
    frameUrl: "claudex-preview://document/image",
    dark: true,
    platform: "darwin",
    canSave: true,
    canCopy: false,
  });
  assert.match(html, /data-cmd="download"/);
  assert.doesNotMatch(html, /data-cmd="copy"/);
  assert.match(html, /event.source === frame.contentWindow/);
});
