import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, createElement as h, useRef, useState } from "react";
import type { Conversation, GeneratedFile } from "../../shared/types";
import type { Artifact } from "../../src/ui/ArtifactTypes";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { HostContext } from "../../src/host/HostContext";
import { hostFor } from "../../shared/host";
import { ArtifactsPage } from "../../src/artifacts/ArtifactsPage";
import { ArtifactCard } from "../../src/artifacts/ArtifactCard";
import { ArtifactPanel } from "../../src/artifacts/FileViewer";
import { ArtifactChrome } from "../../src/artifacts/ArtifactChrome";
import {
  ArtifactAccountScope,
  ArtifactConversation,
} from "../../src/artifacts/artifact-metadata";
import { ArtifactSelection } from "../../src/artifacts/artifact-context";
import { ArtifactPresentation } from "../../src/artifacts/artifact-presentation";
import {
  openArtifact,
  useGeneratedArtifactSync,
  viewerProps,
} from "../../src/app/ArtifactHost";
import { artifactVersions } from "../../src/artifacts/artifact-versions";
import { GeneratedFileCard } from "../../src/artifacts/GeneratedFileCard";
import { generatedArtifact } from "../../src/artifacts/generatedArtifact";
import { collectArtifacts } from "../../src/artifacts/artifact-collection";
import { artifactChatAction } from "../../src/artifacts/related-sessions";
import { artifactRouteId } from "../../src/artifacts/artifact-route-model";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";
import { loadHighlight } from "../../src/ui/lazy-highlight";
import { routineDom } from "../support/routine-dom";

before(() => Promise.all([preloadMarkdownRenderer(), loadHighlight()]));
const noop = () => {};
const library = { version: 1 as const, copies: [], pinned: [] };
async function exportDownload(env: Awaited<ReturnType<typeof dom>>) {
  for (const label of ["Export", "Download"]) {
    const button = [
      ...env.document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((value) => value.textContent?.includes(label));
    assert.ok(
      button,
      `${label}: ${[...env.document.querySelectorAll('[role="menuitem"]')].map((value) => value.textContent).join(" | ")}`,
    );
    await env.event(button, "click");
  }
}
function file(number: number, binary = false): GeneratedFile {
  return {
    id: `write-${number}`,
    path: binary ? "/work/chart.png" : "/work/page.html",
    name: binary ? "chart.png" : "page.html",
    language: binary ? "text" : "html",
    state: "ready",
    operation: number === 1 ? "create" : "update",
    digest: `${binary ? "binary" : "html"}-${number}`,
    capturedAt: number,
    ...(binary
      ? { blob: true, mime: "image/png", bytes: number }
      : {
          content: `<html><title>Page</title><body>Version ${number}</body></html>`,
        }),
  };
}
function conversation(count = 2, binary = false): Conversation {
  return {
    id: "owner",
    title: "Artifact session",
    mode: "chat",
    providerId: "default",
    model: "model",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: count,
    turns: Array.from({ length: count }, (_, i) => ({
      id: `turn-${i + 1}`,
      prompt: "Create a page",
      attachments: [],
      status: "completed" as const,
      createdAt: i + 1,
      items: [
        {
          id: `message-${i + 1}`,
          type: "agentMessage" as const,
          text: "",
          generatedFiles: [file(i + 1, binary)],
        },
      ],
    })),
  };
}
async function dom(bridge: Partial<Window["desktop"]> = {}) {
  const env = await routineDom(bridge, { jsdom: true });
  const extra = {
    CustomEvent: env.window.CustomEvent,
    DOMParser: env.window.DOMParser,
    XMLSerializer: env.window.XMLSerializer,
    innerWidth: 1440,
    innerHeight: 900,
    matchMedia: env.window.matchMedia,
  };
  const saved = new Map(
    Object.keys(extra).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(extra))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  return {
    ...env,
    async clean() {
      await env.clean();
      for (const [key, value] of saved) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("existing web gallery tabs filter real cards and all four templates dispatch their actual kind", async () => {
  const env = await dom();
  try {
    const created: unknown[][] = [],
      opened: Artifact[] = [];
    const yours: Artifact = {
      id: "own",
      name: "Own page",
      language: "text",
      content: "own",
      pinned: true,
    };
    const shared = {
      ...yours,
      id: "shared",
      name: "Shared page",
      content: "shared",
      sharedWithYou: true,
      pinned: false,
    };
    const style = env.document.createElement("style");
    style.textContent = readFileSync(
      new URL("../../src/artifacts/gallery.css", import.meta.url),
      "utf8",
    );
    env.document.head.append(style);
    const page = (kind: "web" | "desktop") =>
      h(
        HostContext.Provider,
        { value: hostFor(kind) },
        h(ArtifactsPage, {
          artifacts: [yours, shared],
          onOpenArtifact: (a) => opened.push(a),
          onCreate: (...args) => created.push(args),
          onComment: async () => {},
          authorName: "Reader",
          onShareRequestConsumed: noop,
          onDuplicate: async () => {},
          onPin: async () => {},
          onDelete: noop,
          width: 68,
          onResize: noop,
          onClose: noop,
          onError: (e) => {
            throw e;
          },
          onNotify: noop,
        }),
      );
    await env.render(page("web"));
    const galleryStyle = () =>
      env.window.getComputedStyle(
        env.document.querySelector(".artifacts-page")!,
      );
    const titleStyle = () =>
      env.window.getComputedStyle(
        env.document.querySelector(".artifacts-header > h1")!,
      );
    assert.equal(galleryStyle().paddingInline, "40px");
    assert.equal(galleryStyle().scrollbarWidth, "thin");
    assert.equal(galleryStyle().scrollbarGutter, "stable");
    assert.equal(
      titleStyle().fontFamily,
      '"Claudex Serif", Georgia, "PingFang SC", "Microsoft YaHei", serif',
    );
    assert.deepEqual(
      [titleStyle().fontSize, titleStyle().lineHeight, titleStyle().fontWeight],
      ["24px", "32px", "500"],
    );
    const tabs = () => [...env.document.querySelectorAll('[role="tab"]')];
    assert.deepEqual(
      tabs().map((a) => a.textContent),
      ["All", "Yours", "Shared with you"],
    );
    await env.event(tabs()[1], "click");
    assert.equal(env.window.location.search, "?tab=mine");
    assert.match(
      env.document.querySelector('[role="tabpanel"]')!.textContent!,
      /Own page/,
    );
    assert.doesNotMatch(
      env.document.querySelector('[role="tabpanel"]')!.textContent!,
      /Shared page/,
    );
    await env.event(tabs()[2], "click");
    assert.equal(env.window.location.search, "?tab=shared");
    assert.doesNotMatch(
      env.document.querySelector('[role="tabpanel"]')!.textContent!,
      /Own page/,
    );
    await env.event(tabs()[2], "keydown", { key: "Home" });
    assert.equal(tabs()[0].getAttribute("aria-selected"), "true");
    const templates = [
      ...env.document.querySelectorAll<HTMLButtonElement>(
        ".artifacts-make-card",
      ),
    ];
    assert.deepEqual(
      templates.map((a) => a.getAttribute("aria-label")),
      ["Docs, New", "Slides, New", "Design, New", "Dashboard, Beta"],
    );
    for (const template of templates) await env.event(template, "click");
    assert.deepEqual(
      created.map((a) => a[1]),
      ["docs", "slides", "design", "dashboard"],
    );
    const link = env.document.querySelector<HTMLAnchorElement>(
      '.artifacts-grid a[href^="/artifact/"]',
    )!;
    assert.ok(link);
    await env.event(link, "click", { button: 0 });
    assert.equal(opened.length, 1);
    await env.render(page("desktop"));
    assert.equal(galleryStyle().paddingLeft, "48px");
    assert.equal(galleryStyle().paddingRight, "40px");
    assert.equal(galleryStyle().paddingInline, "");
    assert.equal(galleryStyle().scrollbarWidth, "auto");
    // The page title is the serif voice on the desktop too.
    assert.equal(titleStyle().fontFamily.includes("Claudex Serif"), true);
  } finally {
    await env.clean();
  }
});

async function historicalHarness(binary = false, repeatedContent = false) {
  const saved: unknown[][] = [],
    reads: string[] = [];
  const env = await dom({
    saveArtifact: async (name, content) => {
      saved.push([name, content]);
      return name;
    },
    saveGeneratedFile: async (digest, name) => {
      saved.push([name, digest]);
      return name;
    },
    readGeneratedFile: async (digest) => {
      reads.push(digest);
      return Buffer.from(digest).toString("base64");
    },
    syncArtifactShare: async (input) => ({
      identity: input.identity,
      visibility: "private",
      showInList: true,
    }),
  });
  let app!: AppController, update!: (count: number) => void;
  const history = (count: number) => {
    const value = conversation(count, binary);
    if (repeatedContent)
      for (const [index, turn] of value.turns.entries())
        if (index >= 2 && index % 2 === 0)
          turn.items[0].generatedFiles = [
            {
              ...file(1, binary),
              id: file(index + 1, binary).id,
              capturedAt: index + 1,
              operation: "update",
            },
          ];
    return value;
  };
  const original = history(repeatedContent ? 3 : 2);
  function Harness() {
    const [c, setConversation] = useState(original);
    const [artifact, setArtifact] = useState<Artifact>();
    const presentation = useRef(new ArtifactPresentation());
    update = (count) => setConversation(history(count));
    app = {
      accountId: "account-a",
      page: "chat",
      mode: "chat",
      activeId: c.id,
      active: c,
      snapshot: {
        conversations: [c],
        artifactLibrary: library,
        artifactShares: [],
        settings: { name: "Reader" },
      },
      artifact,
      setArtifact,
      artifactPresentation: presentation,
      artifactWidth: 68,
      setArtifactWidth: noop,
      panel: null,
      setPanel: noop,
      toolPanels: { dock: [], close: noop },
      report(e: unknown) {
        throw e;
      },
      notify: noop,
    } as unknown as AppController;
    useGeneratedArtifactSync([c], artifact, setArtifact);
    const open = (value: Artifact) => openArtifact(app, value);
    return h(
      AppContext.Provider,
      { value: app },
      h(
        ArtifactAccountScope.Provider,
        {
          value: {
            id: "account-a",
            legacyOwner: false,
            conversationIds: new Set([c.id]),
          },
        },
        h(
          ArtifactConversation.Provider,
          { value: c.id },
          h(
            ArtifactSelection.Provider,
            { value: artifact },
            ...original.turns.map((turn, i) =>
              h(
                "section",
                { key: turn.id, "data-card": i + 1 },
                binary
                  ? h(GeneratedFileCard, {
                      file: turn.items[0].generatedFiles![0],
                      onArtifact: open,
                    })
                  : h(ArtifactCard, {
                      artifact: generatedArtifact(
                        turn.items[0].generatedFiles![0],
                      )!,
                      onArtifact: open,
                    }),
              ),
            ),
            h(
              "button",
              {
                id: "latest",
                onClick: () =>
                  open({
                    ...generatedArtifact(
                      c.turns.at(-1)!.items[0].generatedFiles![0],
                    )!,
                    conversationId: c.id,
                    surface: binary ? "file" : "artifact",
                  }),
              },
              "Open latest",
            ),
            artifact
              ? h(ArtifactPanel, { artifact, ...viewerProps(app) })
              : null,
          ),
        ),
      ),
    );
  }
  await env.render(h(Harness));
  return {
    ...env,
    saved,
    reads,
    app: () => app,
    update: (count: number) => act(async () => update(count)),
  };
}

test("transcript HTML card preserves v1 preview and download through Host sync; v2 card switches instead of closing", async () => {
  const env = await historicalHarness();
  try {
    await env.click('[data-card="1"] .artifact-card-main');
    assert.equal(env.app().artifact?.sourceDigest, "html-1");
    assert.equal(env.app().artifact?.versionPinned, true);
    assert.match(
      env.document.querySelector(".artifact-viewing-version")!.textContent!,
      /Version 1/,
    );
    assert.match(env.document.querySelector("iframe")!.srcdoc, /Version 1/);
    await env.click(".artifact-title-options");
    await exportDownload(env);
    assert.equal(env.saved[0][1], file(1).content);
    await env.update(3);
    assert.equal(env.app().artifact?.sourceDigest, "html-1");
    assert.match(env.document.querySelector("iframe")!.srcdoc, /Version 1/);
    await env.click('[data-card="2"] .artifact-card-main');
    assert.equal(env.app().artifact?.sourceDigest, "html-2");
    assert.equal(
      env.document
        .querySelector('[data-card="1"] .artifact-card-main')!
        .getAttribute("aria-pressed"),
      "false",
    );
    assert.equal(
      env.document
        .querySelector('[data-card="2"] .artifact-card-main')!
        .getAttribute("aria-pressed"),
      "true",
    );
    await env.click(".artifact-title-options");
    await exportDownload(env);
    assert.equal(env.saved[1][1], file(2).content);
    await env.click('[data-card="2"] .artifact-card-main');
    assert.equal(env.app().artifact, undefined);
  } finally {
    await env.clean();
  }
});

for (const binary of [false, true])
  test(`equal-content historical ${binary ? "binary" : "HTML"} writes retain their selected identity through card clicks and history navigation`, async () => {
    const env = await historicalHarness(binary, true);
    try {
      await env.click('[data-card="1"] .artifact-card-main');
      assert.equal(
        env.app().artifact?.id,
        generatedArtifact(file(1, binary))!.id,
      );
      assert.equal(env.app().artifact?.updatedAt, 1);
      assert.equal(env.app().artifact?.versionPinned, true);
      const assertVersion = (number: number) => {
        if (binary)
          assert.equal(
            env.document
              .querySelector(".artifact-version-button")!
              .getAttribute("aria-label"),
            `Switch artifact version, currently version ${number}`,
          );
        else
          assert.match(
            env.document.querySelector(".artifact-viewing-version")!
              .textContent!,
            new RegExp(`Version ${number}`),
          );
      };
      assertVersion(1);
      if (binary) {
        assert.ok(env.reads.includes("binary-1"));
        await env.click(".file-viewer > header .small-action");
      } else {
        assert.match(env.document.querySelector("iframe")!.srcdoc, /Version 1/);
        await env.click(".artifact-title-options");
        await exportDownload(env);
      }
      assert.deepEqual(
        env.saved[0],
        binary ? ["chart.png", "binary-1"] : ["page.html", file(1).content],
      );
      if (binary) {
        await env.click(".artifact-version-button");
        await env.click('[role="menuitemradio"][aria-label="Version 2"]');
      } else {
        await env.click(".artifact-title-options");
        await env.click('[data-testid="frame-title-menu-versions"]');
        const version = [
          ...env.document.querySelectorAll('[role="menuitem"]'),
        ].find((row) => row.textContent?.includes("Version 2"));
        assert.ok(version);
        await env.event(version, "click");
      }
      await env.click('[data-card="3"] .artifact-card-main');
      assert.equal(
        env.app().artifact?.id,
        `generated:write-3:${binary ? "binary" : "html"}-1`,
      );
      assert.equal(env.app().artifact?.updatedAt, 3);
      assert.equal(env.app().artifact?.versionPinned, undefined);
      await env.click('[data-card="1"] .artifact-card-main');
      assert.equal(env.app().artifact?.updatedAt, 1);
      assertVersion(1);
      await env.update(5);
      assert.equal(env.app().artifact?.updatedAt, 1);
      await env.click('[data-card="3"] .artifact-card-main');
      assert.equal(env.app().artifact?.updatedAt, 3);
      assert.equal(env.app().artifact?.versionPinned, true);
      assertVersion(3);
      assert.equal(
        env.document
          .querySelector('[data-card="1"] .file-document-card')!
          .classList.contains("is-open"),
        false,
      );
      assert.equal(
        env.document
          .querySelector('[data-card="3"] .file-document-card')!
          .classList.contains("is-open"),
        true,
      );
    } finally {
      await env.clean();
    }
  });

test("ordinary latest open and a current transcript card continue following new writes", async () => {
  const env = await historicalHarness();
  try {
    await env.click('[data-card="2"] .artifact-card-main');
    assert.equal(env.app().artifact?.versionPinned, undefined);
    await env.update(3);
    assert.equal(env.app().artifact?.sourceDigest, "html-3");
    await env.click("#latest");
    assert.equal(env.app().artifact, undefined);
    await env.click("#latest");
    await env.update(4);
    assert.equal(env.app().artifact?.sourceDigest, "html-4");
    assert.match(env.document.querySelector("iframe")!.srcdoc, /Version 4/);
  } finally {
    await env.clean();
  }
});

test("historical binary card previews and downloads the selected digest; Latest follows subsequent writes", async () => {
  const env = await historicalHarness(true);
  try {
    await env.click('[data-card="1"] .artifact-card-main');
    assert.equal(env.app().artifact?.sourceDigest, "binary-1");
    assert.equal(
      env.document
        .querySelector(".artifact-image-preview img")!
        .getAttribute("src"),
      `data:image/png;base64,${Buffer.from("binary-1").toString("base64")}`,
    );
    await env.click(".file-viewer > header .small-action");
    assert.deepEqual(env.saved[0], ["chart.png", "binary-1"]);
    await env.click(".artifact-version-button");
    await env.click('[role="menuitemradio"][aria-label="Version 2 · Latest"]');
    assert.equal(
      env.document
        .querySelector(".artifact-image-preview img")!
        .getAttribute("src"),
      `data:image/png;base64,${Buffer.from("binary-2").toString("base64")}`,
    );
    await env.update(3);
    await env.click(".file-viewer > header .small-action");
    assert.deepEqual(env.saved[1], ["chart.png", "binary-3"]);
    assert.ok(env.reads.includes("binary-1"));
    assert.ok(env.reads.includes("binary-3"));
  } finally {
    await env.clean();
  }
});

test("version selection and binary snapshot cache cannot transfer to another account with equal file identity", async () => {
  const reads: string[] = [];
  const env = await dom({
    readGeneratedFile: async (digest) => {
      reads.push(digest);
      return Buffer.from(String(reads.length)).toString("base64");
    },
  });
  try {
    const versions = artifactVersions(
      conversation(2, true).turns,
      file(1, true).path,
    );
    const panel = (accountId: string) =>
      h(
        ArtifactAccountScope.Provider,
        {
          value: {
            id: accountId,
            legacyOwner: false,
            conversationIds: new Set(["owner"]),
          },
        },
        h(ArtifactPanel, {
          artifact: {
            ...versions[1],
            conversationId: "owner",
            surface: "file",
          },
          versionsOf: () => versions,
          onClose: noop,
          onError: (e) => {
            throw e;
          },
        }),
      );
    await env.render(panel("a"));
    await env.click(".artifact-version-button");
    await env.click('[role="menuitemradio"][aria-label="Version 1"]');
    assert.deepEqual(reads, ["binary-2", "binary-1"]);
    await env.render(panel("b"));
    assert.equal(
      env.document
        .querySelector(".artifact-version-button")!
        .getAttribute("aria-label"),
      "Switch artifact version, currently version 2",
    );
    assert.deepEqual(reads, ["binary-2", "binary-1", "binary-2"]);
    assert.equal(
      env.document
        .querySelector(".artifact-image-preview img")!
        .getAttribute("src"),
      `data:image/png;base64,${Buffer.from("3").toString("base64")}`,
    );
  } finally {
    await env.clean();
  }
});

test("standalone chrome Home and Chat use actual ownership with zero or one session", async () => {
  const env = await dom({
    sharingStatus: async () => ({ artifacts: true }) as never,
    syncArtifactShare: async (input) => ({
      identity: input.identity,
      visibility: "private",
      showInList: true,
    }),
    artifactShareState: async () => ({ share: null, invites: [] }) as never,
    artifactPublication: async () => null,
  });
  try {
    const c = conversation(),
      snapshot = {
        conversations: [c],
        artifactLibrary: library,
        artifactShares: [],
        settings: { name: "Reader" },
      };
    const owned = collectArtifacts([c], [], library)[0];
    const calls: unknown[][] = [];
    const app = {
      accountId: "account",
      controllerScope: {},
      snapshot,
      page: "artifact",
      artifactRouteId: artifactRouteId(owned),
      openConversation: (c: Conversation) => calls.push(["open", c.id]),
      newChat: () => calls.push(["new"]),
      setArtifact: noop,
    } as unknown as AppController;
    const render = (artifact: Artifact) =>
      env.render(
        h(
          AppContext.Provider,
          { value: app },
          h(ArtifactChrome, {
            artifact,
            expanded: true,
            standalone: true,
            authorName: "Reader",
            onHome: () => calls.push(["home"]),
            onExpand: artifactChatAction(app, artifact),
            onClose: noop,
            onRefresh: noop,
            onError: (e) => {
              throw e;
            },
          }),
        ),
      );
    await render(owned);
    assert.equal(
      env.document
        .querySelector(".artifact-current-user")!
        .getAttribute("title"),
      "Reader",
    );
    assert.equal(
      env.document
        .querySelector(".artifact-chat-button")!
        .getAttribute("aria-label"),
      "Chat with Claudex · 1 session here",
    );
    assert.equal(
      env.document
        .querySelector(".artifact-share-button")!
        .getAttribute("aria-label"),
      "Share, private",
    );
    await env.click(".artifact-home-link");
    await env.click(".artifact-chat-button");
    assert.deepEqual(calls, [["home"], ["open", "owner"]]);
    const copy = {
      libraryId: "saved",
      name: "Saved",
      language: "html",
      content: "<p>saved</p>",
      createdAt: 1,
    };
    snapshot.artifactLibrary = {
      version: 1,
      copies: [copy],
      pinned: [],
    } as never;
    const unlinked = collectArtifacts([], [], snapshot.artifactLibrary)[0];
    app.artifactRouteId = artifactRouteId(unlinked);
    await render(unlinked);
    assert.equal(
      env.document
        .querySelector(".artifact-chat-button")!
        .getAttribute("aria-label"),
      "Chat with Claudex · 0 sessions here",
    );
    await env.click(".artifact-chat-button");
    assert.deepEqual(calls.at(-1), ["new"]);
  } finally {
    await env.clean();
  }
});
