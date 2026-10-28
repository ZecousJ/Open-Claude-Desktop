import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { Artifact } from "../../src/ui/ArtifactTypes";
import type { ArtifactSharingState } from "../../shared/sharing-api";
import { ArtifactChrome } from "../../src/artifacts/ArtifactChrome";
import { ArtifactGridCard } from "../../src/artifacts/ArtifactGridCard";
import {
  artifactAccessLabel,
  useArtifactAccess,
} from "../../src/artifacts/artifact-access";

const artifact: Artifact = {
  id: "deck",
  name: "Deck",
  language: "html",
  content: '<section data-slide="1">Slide</section>',
};

test("gallery Slides treatment follows an artifact's supported presentation capability", () => {
  const card = (value: Artifact) =>
    parseHTML(
      renderToStaticMarkup(
        createElement(ArtifactGridCard, {
          artifact: value,
          name: value.name,
          type: "document",
          viewed: false,
          now: 1,
          onOpen() {},
          async onPin() {},
          async onDuplicate() {},
          onDelete() {},
          onDownload() {},
          onCopyLink() {},
          onError() {},
        }),
      ),
    ).document.querySelector(".artifacts-card-tile")!;
  for (const value of [
    artifact,
    {
      ...artifact,
      language: "markdown",
      name: "Quarterly presentation",
      content: "# Slides",
    },
    {
      ...artifact,
      blob: true,
      filename: "deck.pptx",
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      content: "",
    },
  ]) {
    const tile = card(value);
    assert.ok(tile.hasAttribute("data-presentation"));
    assert.equal(
      tile.querySelector("svg")?.getAttribute("data-icon"),
      "Slides",
    );
    assert.equal(tile.querySelector("svg")?.getAttribute("width"), "16");
  }
  for (const value of [
    { ...artifact, content: "<p>ordinary page</p>" },
    { ...artifact, generating: true },
    { ...artifact, contentOmitted: true },
  ])
    assert.equal(card(value).hasAttribute("data-presentation"), false);
  const css = readFileSync(
    new URL("../../src/artifacts/gallery.css", import.meta.url),
    "utf8",
  ).replace(/\s+/g, " ");
  assert.match(
    css,
    /\.artifacts-card-tile\[data-presentation\]\s*\{[^}]*background:\s*#1a1a19[^}]*color:\s*#c98500/,
  );
  assert.match(
    css,
    /:root\[data-theme="light"\] \.artifacts-tile\.artifacts-card-tile\[data-presentation\]\s*\{[^}]*color:\s*#a66a00/,
  );
});

test("gallery metadata has the real trailing Pin without nesting it in the opener", () => {
  const document = parseHTML(
    renderToStaticMarkup(
      createElement(ArtifactGridCard, {
        artifact: { ...artifact, pinned: true },
        name: "Deck",
        type: "web",
        viewed: false,
        time: 0,
        now: 1,
        onOpen() {},
        async onPin() {},
        async onDuplicate() {},
        onDelete() {},
        onDownload() {},
        onCopyLink() {},
        onError() {},
      }),
    ),
  ).document;
  const main = document.querySelector(".artifacts-card-main")!;
  const meta = document.querySelector(".artifacts-card-meta")!;
  assert.equal(main.contains(meta), false);
  const pin = meta.querySelector('button[aria-label="Unpin"]')!;
  assert.equal(pin.getAttribute("aria-pressed"), "true");
  assert.equal(
    pin.querySelector("svg")!.getAttribute("data-icon"),
    "PinFilled",
  );
  assert.equal(pin.querySelector("svg")!.getAttribute("width"), "16");
  assert.equal(main.querySelector("button"), null);
  assert.ok(meta.querySelector('[aria-label="Private"]'));
});

test("only the existing standalone web chrome selects 24px comments and compact Share", () => {
  const chrome = (standalone: boolean) =>
    parseHTML(
      renderToStaticMarkup(
        createElement(ArtifactChrome, {
          artifact,
          expanded: true,
          standalone,
          onExpand() {},
          onClose() {},
          onRefresh() {},
          onError() {},
        }),
      ),
    ).document;
  const compact = chrome(true);
  assert.ok(compact.querySelector("header[data-standalone]"));
  assert.ok(
    compact.querySelector('button[aria-label="Comment on this artifact"]'),
  );
  assert.ok(compact.querySelector('button[aria-label="More comment options"]'));
  const embedded = chrome(false);
  assert.equal(embedded.querySelector("header[data-standalone]"), null);
  assert.ok(embedded.querySelector('button[aria-label="Comment"]'));
  const css = readFileSync(
    new URL("../../src/artifacts/file-viewer-panel.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.artifact-collaboration-header\[data-standalone\]\s*\{[^}]*--artifact-comment-height:\s*24px[^}]*--artifact-comment-main-width:\s*24px[^}]*--artifact-comment-more-width:\s*24px[^}]*--artifact-comment-radius:\s*6px/,
  );
  assert.match(
    css,
    /\.artifact-share-button\[data-standalone\]\s*\{[^}]*--artifact-share-height:\s*24px[^}]*--artifact-share-radius:\s*6px/,
  );
  // Share sizes to its label (a short 分享 left a long empty end).
  assert.match(
    css,
    /\.artifact-collaboration \.artifact-share-button \{[^}]*width:\s*auto;[^}]*justify-content:\s*center;/,
  );
  const source = readFileSync(
    new URL("../../src/artifacts/FileViewer.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /standalone=\{fullPage && surface === "web"\}/);
});

const privateState: ArtifactSharingState = {
  share: null,
  versions: [],
  currentVersion: "v1",
  autoUpdate: false,
};
const sharedState = (
  access: "link" | "invited",
  invites: string[] = [],
): ArtifactSharingState => ({
  ...privateState,
  share: {
    id: "shared",
    kind: "artifact",
    sourceKey: "deck",
    title: "Deck",
    url: "https://example.com/s/shared",
    createdAt: 1,
    snapshotAt: 1,
    status: "active",
    access,
    invites,
  },
});

test("Share access distinguishes unknown, private, link and actual invited readers", () => {
  assert.equal(artifactAccessLabel(), undefined);
  assert.equal(artifactAccessLabel(privateState), "Private");
  assert.equal(
    artifactAccessLabel(sharedState("link")),
    "Anyone with the link",
  );
  assert.equal(artifactAccessLabel(sharedState("invited")), "Private");
  assert.equal(
    artifactAccessLabel(sharedState("invited", ["reader@example.com"])),
    "Only people invited",
  );
  assert.equal(
    artifactAccessLabel({
      ...sharedState("link"),
      share: { ...sharedState("link").share!, status: "disabled" },
    }),
    "Private",
  );
});

test("access labels read the Share dialog's record, ignore stale accounts, refresh and make no hidden/native request", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const globals = { window, document, IS_REACT_ACT_ENVIRONMENT: true };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  const pending: {
    resolve(value: ArtifactSharingState): void;
    reject(error: Error): void;
  }[] = [];
  const listeners = new Set<(event: any) => void>();
  const emit = (event: any) => listeners.forEach((listener) => listener(event));
  const fakeDesktop: Pick<
    typeof window.desktop,
    "artifactShareState" | "onEvent"
  > = {
    artifactShareState: () =>
      new Promise<ArtifactSharingState>((resolve, reject) =>
        pending.push({ resolve, reject }),
      ),
    onEvent: (next) => {
      listeners.add(next);
      return () => {
        listeners.delete(next);
      };
    },
  };
  window.desktop = fakeDesktop as unknown as typeof window.desktop;
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  function Harness({
    enabled,
    account,
  }: {
    enabled: boolean;
    account: string;
  }) {
    const access = useArtifactAccess(
      {
        identity: "deck",
        title: "Deck",
        language: "html",
        content: "<p>Deck</p>",
      },
      enabled,
      account,
    );
    return createElement(
      "button",
      { onClick: access.refresh, "aria-label": access.label ?? "Unknown" },
      access.label ?? "Unknown",
    );
  }
  const label = () =>
    document.querySelector("button")!.getAttribute("aria-label");
  const render = (enabled: boolean, account = "a") =>
    act(() => root.render(createElement(Harness, { enabled, account })));
  try {
    await render(false);
    assert.equal(pending.length, 0);
    await render(true);
    assert.equal(label(), "Unknown");
    await act(async () => pending[0].resolve(privateState));
    assert.equal(label(), "Private");
    await act(async () => emit({ type: "sharing", kind: "artifact" }));
    await act(async () => pending[1].resolve(sharedState("link")));
    assert.equal(label(), "Anyone with the link");
    await act(async () => emit({ type: "sharing", kind: "conversation" }));
    assert.equal(pending.length, 2);
    await act(() => document.querySelector("button")!.click());
    assert.equal(label(), "Unknown");
    await render(true, "b");
    assert.equal(label(), "Unknown");
    await act(async () =>
      pending[3].resolve(sharedState("invited", ["reader@example.com"])),
    );
    await act(async () => pending[2].resolve(privateState));
    assert.equal(label(), "Only people invited");
    await act(async () => emit({ type: "service-changed" }));
    await act(async () => pending[4].reject(new Error("unavailable")));
    assert.equal(label(), "Unknown");
    await render(false, "b");
    assert.equal(label(), "Unknown");
    assert.equal(pending.length, 5);

    Object.assign(window.desktop, {
      sharingStatus: async () => ({
        artifacts: true,
        conversations: true,
        maxArtifactBytes: 1000,
        maxSnapshotBytes: 1000,
      }),
      artifactPublication: async () => ({
        share: null,
        liveLinks: 0,
        unpublished: false,
      }),
    });
    const renderChrome = async (standalone: boolean) => {
      await act(async () =>
        root.render(
          createElement(ArtifactChrome, {
            artifact,
            expanded: true,
            standalone,
            onClose() {},
            onExpand() {},
            onRefresh() {},
            onError(error) {
              throw error;
            },
          }),
        ),
      );
      // Publication reads are deliberately deferred by a timer in the host.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    };
    await renderChrome(true);
    const shareButton = () =>
      document.querySelector<HTMLButtonElement>(
        "button.artifact-share-button:not(.artifact-publish-button)",
      )!;
    assert.equal(shareButton().getAttribute("aria-label"), "Share");
    await act(async () => pending[5].resolve(privateState));
    assert.equal(shareButton().getAttribute("aria-label"), "Share, private");
    await act(async () => emit({ type: "sharing", kind: "artifact" }));
    await act(async () => pending[6].resolve(sharedState("link")));
    assert.equal(
      shareButton().getAttribute("aria-label"),
      "Share, anyone with the link",
    );
    await renderChrome(false);
    assert.equal(shareButton().getAttribute("aria-label"), "Share");
    assert.equal(pending.length, 7);

    let pinned = 0;
    let opened = 0;
    await act(() =>
      root.render(
        createElement(ArtifactGridCard, {
          artifact,
          name: "Deck",
          type: "web",
          viewed: false,
          now: 1,
          onOpen() {
            opened++;
          },
          async onPin() {
            pinned++;
          },
          async onDuplicate() {},
          onDelete() {},
          onDownload() {},
          onCopyLink() {},
          onError(error) {
            throw error;
          },
        }),
      ),
    );
    await act(() =>
      document.querySelector<HTMLButtonElement>(".artifacts-card-pin")!.click(),
    );
    assert.equal(pinned, 1);
    assert.equal(opened, 0);
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
