import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { act, createElement, type ReactNode } from "react";
import { parseHTML } from "linkedom";
import { ArtifactData } from "../../electron/artifacts/artifact-data";
import { artifactStorageLines } from "../../shared/artifact-data";
import { ArtifactChrome } from "../../src/artifacts/ArtifactChrome";
import { ArtifactVersionMenu } from "../../src/artifacts/ArtifactExportMenu";
import { ArtifactPreview } from "../../src/artifacts/ArtifactPreview";
import { ArtifactStorageMenu } from "../../src/artifacts/ArtifactStorageMenu";
import { renderToStaticMarkup } from "react-dom/server";
import type { Artifact } from "../../src/ui/ArtifactTypes";
import { relativeTime } from "../../src/ui/RelativeTime";
import { MakeSomethingNew } from "../../src/artifacts/MakeSomethingNew";

test("gallery cards stretch with a two-line title and keep metadata at the row bottom", () => {
  // Current official 1440px DOM: a row with one 40px title has three
  // 254px cards; short-title rows are 234px. The metadata retains an 8px gap.
  const css = fs.readFileSync(
    new URL("../../src/artifacts/gallery.css", import.meta.url),
    "utf8",
  );
  const frame = /\.artifacts-card-main \{([^}]+)\}/.exec(css)?.[1] ?? "";
  assert.match(frame, /height: 100%/);
  assert.match(frame, /min-height: 234px/);
  assert.match(frame, /gap: 8px/);
  assert.match(frame, /padding: 0 0 38px/);
  assert.match(
    css,
    /\.artifacts-card-meta \{[^}]*inset-inline: 14px;[^}]*bottom: 14px;/,
  );
});

async function withDom(
  run: (context: {
    window: ReturnType<typeof parseHTML>["window"];
    document: Document;
    render: (element: ReactNode) => Promise<void>;
    draw: (element: ReactNode) => void;
    click: (selector: string) => Promise<void>;
  }) => Promise<void>,
) {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const globals = {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
    MutationObserver: window.MutationObserver,
    getComputedStyle: () => ({ direction: "ltr", getPropertyValue: () => "8" }),
    requestAnimationFrame: (callback: () => void) => {
      callback();
      return 0;
    },
    CSS: { escape: (value: string) => value },
  };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  Object.assign(window, { desktop: {} });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  try {
    await run({
      window,
      document,
      render: async (element) => {
        await act(async () => root.render(element));
      },
      draw: (element) => root.render(element),
      click: async (selector) => {
        const button = document.querySelector<HTMLButtonElement>(selector);
        assert.ok(button, selector);
        await act(async () => button.click());
      },
    });
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("storage notices begin at 80%, include populated files only, and distinguish document caps", () => {
  const usage = {
    bytes: 79,
    maxBytes: 100,
    documents: 0,
    maxDocuments: 10,
    files: { bytes: 0, maxBytes: 100, files: 0, maxFiles: 10 },
  };
  assert.equal(artifactStorageLines(usage).length, 1);
  assert.equal(artifactStorageLines(usage)[0].low, false);
  assert.equal(artifactStorageLines({ ...usage, bytes: 80 })[0].low, true);
  assert.equal(artifactStorageLines({ ...usage, bytes: 100 })[0].full, true);
  assert.equal(
    artifactStorageLines({ ...usage, documents: 10 })[0].atDocumentCap,
    true,
  );
  const file = artifactStorageLines({
    ...usage,
    files: { ...usage.files, files: 10 },
  })[1];
  assert.equal(file.resource, "files");
  assert.equal(file.full, true);
  assert.equal(file.atDocumentCap, false);
});

test("artifact creation templates are active and carry their creation prompts", () => {
  const markup = renderToStaticMarkup(
    createElement(MakeSomethingNew, { onCreate() {} }),
  );
  assert.match(markup, />Docs</);
  assert.match(markup, />Slides</);
  assert.match(markup, />Design</);
  assert.match(markup, />Dashboard</);
  assert.equal((markup.match(/artifacts-make-badge new/g) ?? []).length, 3);
  assert.match(markup, /artifacts-make-badge">Beta/);
  assert.doesNotMatch(markup, /aria-disabled="true"/);
});

test("storage quotas cover the account, retain artifact isolation, and approve persistent local requests", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-quota-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ArtifactData(root);
  const limit = store.usage("one").maxBytes;
  store.request("one", {
    method: "set",
    key: "large",
    value: "x".repeat(17 * 1024 * 1024),
  });
  assert.equal(store.usage("one").canRequestLimit, true);
  assert.equal(store.usage("two").bytes, store.usage("one").bytes);
  assert.throws(
    () =>
      store.request("two", {
        method: "set",
        key: "other",
        value: "y".repeat(4 * 1024 * 1024),
      }),
    /Artifact storage limit reached/,
  );
  assert.equal(store.request("two", { method: "get", key: "large" }), null);
  assert.equal(store.requestLimit("one").maxBytes, limit * 2);
  assert.equal(new ArtifactData(root).usage("two").maxBytes, limit * 2);
  store.request("two", {
    method: "set",
    key: "other",
    value: "y".repeat(4 * 1024 * 1024),
  });
  store.request("one", {
    method: "set",
    resource: "files",
    key: "large",
    value: "file-data",
  });
  assert.deepEqual(
    store.request("one", { method: "get", resource: "files", key: "large" }),
    { key: "large", value: "file-data" },
  );
  assert.equal(
    store.request("two", { method: "get", resource: "files", key: "large" }),
    null,
  );
  assert.equal(store.usage("one").files!.maxBytes, limit);
  assert.equal(store.usage("one").files!.files, 1);
  assert.equal(
    new ArtifactData(path.join(root, "another-account")).usage("one").maxBytes,
    limit,
  );
  assert.throws(() =>
    store.request("one", {
      method: "set",
      resource: "../data",
      key: "bad",
      value: "no",
    }),
  );
  assert.throws(() => store.request("one", { method: "requestLimit" }));
  store.request("one", { method: "delete", key: "large" });
  assert.equal(store.usage("one").canRequestLimit, false);
});

test("document limits can be raised and deletion still works when existing data is over quota", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-documents-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, "artifact-data");
  fs.mkdirSync(folder);
  const file = path.join(
    folder,
    `${createHash("sha256").update("one").digest("hex")}.json`,
  );
  const data = Object.fromEntries(
    Array.from({ length: 10_001 }, (_, index) => [`key-${index}`, "saved"]),
  );
  fs.writeFileSync(file, JSON.stringify(data));
  const store = new ArtifactData(root);
  assert.equal(artifactStorageLines(store.usage("one"))[0].atDocumentCap, true);
  store.request("one", { method: "delete", key: "key-0" });
  assert.equal(store.usage("one").documents, 10_000);
  assert.throws(
    () => store.request("one", { method: "set", key: "new", value: "value" }),
    /Artifact storage limit reached/,
  );
  assert.equal(store.requestLimit("one").maxDocuments, 20_000);
  store.request("one", { method: "set", key: "new", value: "value" });
  assert.equal(store.usage("one").documents, 10_001);
});

test("Storage exposes usage, low/full notices, and a working limit request with no empty file meter", async () => {
  await withDom(async ({ document, render, draw, click }) => {
    let usage = {
      bytes: 80,
      maxBytes: 100,
      canRequestLimit: true,
      documents: 10,
      maxDocuments: 10,
      files: { bytes: 100, maxBytes: 100, files: 1, maxFiles: 10 },
    };
    let requests = 0;
    const errors: unknown[] = [];
    const element = () =>
      createElement(
        "div",
        { className: "artifact-title-menu" },
        createElement(ArtifactStorageMenu, {
          usage,
          onError: (error) => errors.push(error),
          onRequestLimit: async () => {
            requests++;
            usage = {
              ...usage,
              maxBytes: 200,
              maxDocuments: 20,
              files: { ...usage.files, maxBytes: 200 },
            };
            draw(element());
          },
        }),
      );
    await render(element());
    const trigger = document.querySelector(
      '[data-testid="frame-title-menu-storage"]',
    )!;
    const summary = document.getElementById(
      trigger.getAttribute("aria-describedby")!,
    )!;
    assert.match(summary.textContent!, /Database storage limit: 80 B of 100 B/);
    assert.match(summary.textContent!, /File storage limit: 100 B of 100 B/);
    await click('[data-testid="frame-title-menu-storage"]');
    const header = document.querySelector(".artifact-storage-lines")!;
    assert.match(
      header.textContent!,
      /New data isn’t being saved. Ask Claudex to optimize data storage./,
    );
    assert.match(
      header.textContent!,
      /There’s no room left for new files. Ask Claudex to free up storage./,
    );
    assert.ok(document.querySelector('[role="menu"][data-storage]'));
    await click('[data-testid="frame-title-menu-storage-limit"]');
    assert.equal(requests, 1);
    await click('[data-testid="frame-title-menu-storage"]');
    assert.doesNotMatch(
      document.querySelector(".artifact-storage-lines")!.textContent!,
      /Ask Claudex/,
    );
    assert.equal(
      document.querySelector('[data-testid="frame-title-menu-storage-limit"]'),
      null,
    );
    assert.deepEqual(errors, []);
  });
});

test("the title menu counts artifacts and versions; only opened frames become tabs and can be closed", async () => {
  await withDom(async ({ window, document, render, draw, click }) => {
    const first: Artifact = {
      id: "one",
      name: "First card",
      language: "html",
      content: "one",
      conversationId: "chat",
    };
    const second = { ...first, id: "two", name: "Second card", content: "two" };
    const history = [
      { ...first, name: "Old title", updatedAt: Date.now() - 120_000 },
      { ...first, name: "New title", updatedAt: Date.now() },
    ];
    let artifact = first;
    let count = 2;
    let closed = 0;
    const versions: number[] = [];
    const element = () =>
      createElement(ArtifactChrome, {
        artifact,
        expanded: false,
        versions: count,
        shownVersion: 2,
        versionHistory: history,
        siblings: () => [first, second],
        onSwitch: (next) => {
          artifact = next;
          draw(element());
        },
        onVersion: (version) => versions.push(version),
        onExpand() {},
        onRefresh() {},
        onError(error) {
          throw error;
        },
        onClose: () => {
          closed++;
        },
      });
    await render(element());
    assert.equal(document.querySelectorAll('[role="tab"]').length, 1);
    assert.equal(document.querySelector(".artifact-switch-button"), null);
    assert.equal(document.querySelector(".artifact-version-switcher"), null);
    await click('[role="tab"][aria-selected="true"]');
    assert.equal(
      document
        .querySelector('[data-testid="frame-title-menu-switcher"]')!
        .getAttribute("aria-label"),
      "Switch artifact, 2 artifacts",
    );
    await click('[data-testid="frame-title-menu-switcher"]');
    await click('.artifact-export-submenu [role="menuitemradio"]:last-child');
    assert.equal(artifact.id, "two");
    assert.equal(document.querySelector(".artifact-title-menu"), null);
    assert.equal(document.querySelectorAll('[role="tab"]').length, 2);
    const key = async (value: string) => {
      const event = new window.Event("keydown", { bubbles: true });
      Object.defineProperty(event, "key", { value });
      await act(async () =>
        document
          .querySelector('[role="tab"][aria-selected="true"]')!
          .dispatchEvent(event),
      );
    };
    await key("Home");
    assert.equal(artifact.id, "one");
    await key("End");
    assert.equal(artifact.id, "two");
    await click('[role="tab"][aria-selected="true"]');
    assert.equal(
      document
        .querySelector('[data-testid="frame-title-menu-versions"]')!
        .getAttribute("aria-label"),
      "Version history, 2 versions",
    );
    await click('[data-testid="frame-title-menu-versions"]');
    assert.match(
      document.querySelector("[data-versions] [data-current]")!.textContent!,
      /New titleVersion 2.*Current/,
    );
    assert.match(
      document.querySelector("[data-versions]")!.textContent!,
      /Old titleVersion 1/,
    );
    assert.doesNotMatch(
      document.querySelector("[data-versions]")!.textContent!,
      /Compare|Restore|Download this version/,
    );
    await click("[data-versions] button:last-child");
    assert.deepEqual(versions, [1]);
    count = 0;
    await render(element());
    await click('[role="tab"][aria-selected="true"]');
    assert.equal(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="frame-title-menu-versions"]',
      )!.disabled,
      true,
    );
    await click(".artifact-frame-tab[data-selected] .artifact-frame-tab-close");
    assert.equal(artifact.id, "one");
    assert.equal(document.querySelectorAll('[role="tab"]').length, 1);
    await click(".artifact-frame-tab-close");
    assert.equal(closed, 1);
  });
});

test("a failed frame boot clears loading and exposes the existing runtime error card", async () => {
  await withDom(async ({ window, document, render }) => {
    const failure = new Error("Preview boot failed");
    Object.assign(window.desktop, {
      createArtifactPreview: async () => {
        throw failure;
      },
    });
    const errors: unknown[] = [];
    await render(
      createElement(ArtifactPreview, {
        artifact: {
          id: "one",
          name: "Card",
          language: "html",
          content: "<p>one</p>",
        },
        refresh: 0,
        onError: (error) => errors.push(error),
        onDownload() {},
      }),
    );
    assert.equal(
      document.querySelector(".file-preview")!.getAttribute("aria-busy"),
      "false",
    );
    assert.equal(document.querySelector(".artifact-frame-loading"), null);
    assert.match(document.body.textContent!, /Preview boot failed/);
    assert.deepEqual(errors, [failure]);
  });
});

test("version counts use singular copy and narrow dates preserve the official relative format", () => {
  assert.match(
    renderToStaticMarkup(
      createElement(ArtifactVersionMenu, { count: 1, shown: 1, onChoose() {} }),
    ),
    /aria-label="Version history, 1 version"/,
  );
  assert.equal(
    relativeTime(0, 120_000, undefined, "narrow"),
    new Intl.RelativeTimeFormat("en", {
      numeric: "auto",
      style: "narrow",
    }).format(-2, "minute"),
  );
});

test("frame loading is delayed, announced, cleared on load, and restarted for content and refresh", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  context.after(() => context.mock.timers.reset());
  await withDom(async ({ window, document, render }) => {
    let artifact: Artifact = {
      id: "one",
      name: "Card",
      language: "html",
      content: "<p>one</p>",
    };
    let refresh = 0;
    const element = () =>
      createElement(ArtifactPreview, {
        artifact,
        refresh,
        onError(error) {
          throw error;
        },
        onDownload() {},
      });
    await render(element());
    assert.equal(document.querySelector('[role="status"]')!.textContent, "");
    await act(async () => context.mock.timers.tick(999));
    assert.equal(document.querySelector('[role="status"]')!.textContent, "");
    await act(async () => context.mock.timers.tick(1));
    assert.match(
      document.querySelector('[role="status"]')!.textContent!,
      /Loading artifact…/,
    );
    assert.ok(document.querySelector('[role="status"] .sr-only'));
    const frame = document.querySelector("iframe")!;
    await act(async () => frame.dispatchEvent(new window.Event("load")));
    assert.equal(document.querySelector('[role="status"]'), null);
    artifact = { ...artifact, content: "<p>two</p>" };
    await render(element());
    assert.notEqual(document.querySelector("iframe"), frame);
    assert.equal(
      document.querySelector(".file-preview")!.getAttribute("aria-busy"),
      "true",
    );
    assert.equal(document.querySelector('[role="status"]')!.textContent, "");
    await act(async () => context.mock.timers.tick(1000));
    assert.match(
      document.querySelector('[role="status"]')!.textContent!,
      /Loading artifact…/,
    );
    await act(async () =>
      document.querySelector("iframe")!.dispatchEvent(new window.Event("load")),
    );
    const refreshed = document.querySelector("iframe");
    refresh++;
    await render(element());
    assert.notEqual(document.querySelector("iframe"), refreshed);
    assert.equal(
      document.querySelector(".file-preview")!.getAttribute("aria-busy"),
      "true",
    );
  });
});
