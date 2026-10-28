import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ArtifactExportNudge } from "../../src/artifacts/ArtifactExportMenu";
import { ArtifactChrome } from "../../src/artifacts/ArtifactChrome";
import {
  ArtifactMetadataProvider,
  artifactNoteKeyOf,
} from "../../src/artifacts/artifact-metadata";
import { setLocale, formatText } from "../../src/i18n";
import type { HostedShare } from "../../shared/sharing-api";

test("export nudge offers sharing before publication and the public link afterward", () => {
  const render = (shared: boolean, busy = false) =>
    renderToStaticMarkup(
      createElement(ArtifactExportNudge, { shared, busy, onShare() {} }),
    );
  assert.match(render(false), /Sending this to someone\?/);
  assert.match(
    render(false),
    /Share the link instead of a file and they will always have the latest changes\./,
  );
  assert.match(render(false), /Share and copy link/);
  assert.match(render(true), /Copy public link/);
  assert.doesNotMatch(
    render(true),
    /Share and copy link|can comment|can edit|Invite people/,
  );
  assert.match(render(false, true), /disabled="" aria-busy="true"/);
});

test("artifact export clears preparation on save, cancel, or error, and shares or copies a public link", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const globals = {
    window,
    document,
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: () => ({ getPropertyValue: () => "0" }),
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
      configurable: true,
      writable: true,
      value,
    });
  let finish: (path: string | null) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const calls: string[][] = [];
  const artifact = {
    id: "card",
    name: "Card",
    language: "text",
    content: "current",
  };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  let published: HostedShare | null = null;
  let publishCalls = 0;
  const copied: string[] = [];
  Object.assign(window, {
    desktop: {
      voiceAvailability: async () => ({
        transcription: false,
        maxTranscriptionBytes: null,
        maxSeconds: null,
      }),
      onEvent: () => () => {},
      artifactNotes: async () => ({
        [artifactNoteKeyOf(artifact)]: {
          comments: [
            {
              id: "comment",
              text: "Hello",
              x: 0.5,
              y: 0.5,
              createdAt: 1,
              resolved: false,
            },
          ],
        },
      }),
      sharingStatus: async () => ({
        artifacts: true,
        conversations: true,
        maxArtifactBytes: 10000,
        maxSnapshotBytes: 10000,
      }),
      artifactPublication: async () => ({
        share: published,
        liveLinks: published ? 1 : 0,
        unpublished: false,
      }),
      publishArtifact: async () => {
        publishCalls++;
        published = {
          id: "public",
          kind: "artifact",
          sourceKey: "card",
          title: "Card",
          status: "active",
          url: "https://share.example.test/s/card",
          createdAt: 1,
          snapshotAt: 1,
        };
        return published;
      },
      copyText: async (text: string) => {
        copied.push(text);
      },
      saveArtifact: (name: string, content: string) => {
        calls.push([name, content]);
        return new Promise<string | null>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        });
      },
    },
  });
  const notices: string[] = [];
  const errors: unknown[] = [];
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  try {
    await act(async () =>
      root.render(
        createElement(ArtifactMetadataProvider, {
          accountId: "test",
          legacyOwner: false,
          conversationIds: new Set<string>(),
          children: createElement(ArtifactChrome, {
            artifact,
            authorName: "Sam",
            shown: { ...artifact, filename: "earlier.txt", content: "earlier" },
            expanded: false,
            onExpand() {},
            onClose() {},
            onRefresh() {},
            onError: (error) => errors.push(error),
            onNotify: (message) => notices.push(message),
          }),
        }),
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const click = async (selector: string) => {
      const button = document.querySelector<HTMLButtonElement>(selector);
      assert.ok(button, selector);
      await act(async () => {
        button.click();
      });
    };
    const download = async () => {
      await click(".artifact-title-options");
      await click(".artifact-export-entry > button");
      await click(".artifact-export-submenu button");
      assert.match(
        document.querySelector("[data-artifact-download-status]")
          ?.textContent ?? "",
        /Preparing the file…/,
      );
    };
    await download();
    assert.deepEqual(calls, [["earlier.txt", "earlier"]]);
    await act(async () => finish("/tmp/earlier.txt"));
    assert.equal(
      document.querySelector("[data-artifact-download-status]"),
      null,
    );
    assert.deepEqual(notices, ["Saved earlier.txt"]);
    await download();
    await act(async () => finish(null));
    assert.equal(
      document.querySelector("[data-artifact-download-status]"),
      null,
    );
    assert.equal(notices.length, 1);
    await download();
    const error = new Error("save failed");
    await act(async () => fail(error));
    assert.equal(
      document.querySelector("[data-artifact-download-status]"),
      null,
    );
    assert.equal(errors.length, 1);
    assert.equal(
      (errors[0] as Error).message,
      "Couldn’t download this artifact. Try again.",
    );
    await click(".artifact-title-options");
    await click(".artifact-export-entry > button");
    assert.equal(
      document.querySelector(".artifact-export-nudge button")?.textContent,
      "Share and copy link",
    );
    await click(".artifact-export-nudge button");
    assert.equal(publishCalls, 1);
    assert.deepEqual(copied, ["https://share.example.test/s/card"]);
    assert.equal(
      document.querySelector(".artifact-export-nudge button")?.textContent,
      "Copy public link",
    );
    await click(".artifact-export-nudge button");
    assert.equal(publishCalls, 1);
    assert.deepEqual(copied, [
      "https://share.example.test/s/card",
      "https://share.example.test/s/card",
    ]);
    assert.deepEqual(notices, [
      "Saved earlier.txt",
      "Link copied",
      "Link copied",
    ]);
    await click(".artifact-comment-pin");
    const announcement = document.querySelector("[data-comment-open-said]");
    assert.equal(announcement?.textContent, "Opened comment from Sam");
    assert.equal(announcement?.getAttribute("role"), "status");
    assert.equal(announcement?.getAttribute("aria-live"), "polite");
    assert.equal(announcement?.className, "sr-only");
    assert.equal(notices.length, 3);
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("opened-comment announcements interpolate the author in every locale", async () => {
  try {
    for (const locale of [
      "zh-CN",
      "ja-JP",
      "ko-KR",
      "de-DE",
      "fr-FR",
      "es-ES",
      "es-419",
      "it-IT",
      "pt-BR",
      "id-ID",
      "hi-IN",
    ]) {
      await setLocale(locale);
      const message = formatText("Opened comment from {name}", { name: "Sam" });
      assert.ok(message.includes("Sam"), locale);
      assert.ok(!message.includes("{name}"), locale);
      assert.notEqual(message, "Opened comment from Sam", locale);
    }
  } finally {
    await setLocale("en-US");
  }
});
