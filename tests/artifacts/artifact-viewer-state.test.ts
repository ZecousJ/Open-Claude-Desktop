import test, { before } from "node:test";
import assert from "node:assert/strict";
import { act, createElement, useRef, useState, type ReactNode } from "react";
import { parseHTML } from "linkedom";
import type { Conversation } from "../../shared/types";
import { hostFor } from "../../shared/host";
import { fixtureSnapshot } from "../../scripts/preview/app-fixture";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { openArtifact, viewerProps } from "../../src/app/ArtifactHost";
import { ShellMenuHost } from "../../src/app/ShellMenuHost";
import { runShellCommand } from "../../src/app/shell-menu";
import { useToolPanels } from "../../src/app/useToolPanels";
import { ArtifactPresentation } from "../../src/artifacts/artifact-presentation";
import {
  artifactIdentity,
  artifactNoteKeyOf,
} from "../../src/artifacts/artifact-metadata";
import {
  artifactVersions,
  versionIdOf,
} from "../../src/artifacts/artifact-versions";
import { generatedArtifact } from "../../src/artifacts/generatedArtifact";
import { ArtifactPanel } from "../../src/artifacts/FileViewer";
import { ActivityPanel } from "../../src/cowork/ActivityPanel";
import { requestProgressSteps } from "../../src/cowork/progress-request";
import type { Artifact } from "../../src/ui/ArtifactTypes";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";
import { loadHighlight } from "../../src/ui/lazy-highlight";

before(() => Promise.all([preloadMarkdownRenderer(), loadHighlight()]));

async function withDom(
  run: (dom: {
    document: Document;
    render(element: ReactNode): Promise<void>;
    click(selector: string): Promise<void>;
  }) => Promise<void>,
) {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const globals = {
    window,
    document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    CustomEvent: window.CustomEvent,
    MutationObserver: window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
    innerWidth: 1440,
    innerHeight: 900,
    matchMedia: (query: string) => ({
      matches: query === "(max-width: 639.98px)" && globalThis.innerWidth < 640,
    }),
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
      configurable: true,
      writable: true,
    });
  window.desktop = {
    onEvent: () => () => {},
    setLayoutCommandListening: async () => {},
    mcpServers: async () => ({ servers: [] }),
    linearStatus: async () => ({ connected: false }),
  } as unknown as typeof window.desktop;
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  try {
    await run({
      document,
      render: async (element) => {
        await act(async () => root.render(element));
      },
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

function fixture(mode: Conversation["mode"] = "chat", repeatWriteId = false) {
  const snapshot = fixtureSnapshot({ artifacts: true });
  const c = structuredClone(
    snapshot.conversations.find((value) => value.id === "c-artifact-versions")!,
  );
  c.mode = mode;
  // A content reversion retains three independent history positions, even
  // when the raw capture ID and timestamp below collide too.
  const first = c.turns[0].items[0].generatedFiles![0];
  const third = c.turns[2].items[0].generatedFiles![0];
  third.content = first.content;
  third.digest = first.digest;
  if (repeatWriteId)
    for (const turn of c.turns) {
      const file = turn.items[0].generatedFiles![0];
      file.id = first.id;
      file.capturedAt = 1234;
    }
  snapshot.conversations = [c, { ...structuredClone(c), id: "other" }];
  const versions = artifactVersions(c.turns, first.path).map((value) => ({
    ...value,
    conversationId: c.id,
    surface: "artifact" as const,
  }));
  const sibling = {
    ...generatedArtifact(c.turns[0].items[0].generatedFiles![1])!,
    conversationId: c.id,
    surface: "artifact" as const,
  };
  return { snapshot, c, versions, sibling };
}

async function withHost(
  mode: Conversation["mode"],
  run: (host: {
    app(): AppController;
    versions: Artifact[];
    sibling: Artifact;
    act(run: () => void): Promise<void>;
    focusCount(): number;
    document: Document;
    click(selector: string): Promise<void>;
    resize(width: number): void;
  }) => Promise<void>,
  shell = false,
  activity = false,
  hostKind?: "web" | "desktop",
) {
  await withDom(async ({ render, document, click }) => {
    const { snapshot, c, versions, sibling } = fixture(mode);
    let app: AppController;
    let focused = 0;
    function Harness() {
      const toolPanels = useToolPanels();
      const [artifact, setArtifact] = useState<Artifact>();
      const [activeId, setActiveId] = useState<string | undefined>(c.id);
      const [artifactWidth, setArtifactWidth] = useState(50);
      const artifactPresentation = useRef(new ArtifactPresentation());
      app = {
        windowRole: { kind: "main" },
        mode: mode === "code" ? "code" : "chat",
        page: "chat",
        accountId: "fixture",
        host: hostKind ? hostFor(hostKind) : undefined,
        policy: {},
        sidebarView: { open: true },
        navigation: {},
        snapshot,
        activeId,
        active: snapshot.conversations.find((value) => value.id === activeId),
        setActiveId,
        artifact,
        setArtifact,
        artifactWidth,
        setArtifactWidth,
        artifactPresentation,
        toolPanels,
        panel: toolPanels.panel,
        setPanel: toolPanels.setPanel,
        composer: {
          current: {
            focus() {
              focused++;
            },
          },
        },
        notify() {},
        report(error: unknown) {
          throw error;
        },
      } as unknown as AppController;
      return createElement(
        AppContext.Provider,
        { value: app },
        createElement("output", null, toolPanels.panel ?? "none"),
        shell ? createElement(ShellMenuHost) : null,
        activity && app.active && toolPanels.panel === "progress" && !artifact
          ? createElement(ActivityPanel, {
              conversation: app.active,
              onArtifact: (value) => openArtifact(app, value),
              onClose: () => app.setPanel(null),
            })
          : null,
        activity && artifact
          ? createElement(ArtifactPanel, { artifact, ...viewerProps(app) })
          : null,
      );
    }
    await render(createElement(Harness));
    await run({
      app: () => app!,
      versions,
      sibling,
      focusCount: () => focused,
      document,
      click,
      resize: (width) => {
        globalThis.innerWidth = width;
      },
      act: async (run) => {
        await act(async () => run());
      },
    });
  });
}

for (const mode of ["chat", "cowork"] as const) {
  test(`${mode}: actual Activity Outputs → viewer versions → Close keeps section disclosures`, async () => {
    await withHost(
      mode,
      async ({ app, act, document, click }) => {
        const original = app().activeId!;
        await act(() => app().setPanel("progress"));
        const heading = (title: string) => {
          const result = [
            ...document.querySelectorAll<HTMLButtonElement>(
              ".progress-section-heading",
            ),
          ].find(
            (button) =>
              button.querySelector(".progress-section-title")?.textContent ===
              title,
          );
          assert.ok(result, title);
          return result;
        };
        const toggle = async (title: string) => {
          await act(() => heading(title).click());
        };
        assert.equal(heading("Outputs").getAttribute("aria-expanded"), "false");
        await toggle("Outputs");
        await toggle("Progress");
        await toggle("Context");
        await click('.progress-resource-row > button[title$="landing.html"]');
        assert.equal(document.querySelector(".progress-panel"), null);
        assert.ok(document.querySelector(".artifact-panel"));
        for (const version of [1, 3]) {
          await click(".artifact-version-button");
          await click(
            `[role="menuitemradio"][aria-label="Version ${version}${version === 3 ? " · Latest" : ""}"]`,
          );
        }
        await click('button[aria-label="Close"]');
        assert.equal(app().panel, "progress");
        assert.equal(heading("Outputs").getAttribute("aria-expanded"), "true");
        assert.equal(heading("Progress").getAttribute("aria-expanded"), "true");
        assert.equal(heading("Context").getAttribute("aria-expanded"), "false");
        assert.ok(
          document.querySelector(
            '.progress-resource-row > button[title$="landing.html"]',
          ),
        );
        await toggle("Progress");
        await click('.progress-resource-row > button[title$="landing.html"]');
        await act(() => requestProgressSteps(original));
        await click('button[aria-label="Close"]');
        assert.equal(heading("Progress").getAttribute("aria-expanded"), "true");
        // Reusing the component for another conversation does not inherit these choices.
        await act(() => app().setActiveId("other"));
        assert.equal(heading("Outputs").getAttribute("aria-expanded"), "false");
        assert.equal(
          heading("Progress").getAttribute("aria-expanded"),
          "false",
        );
        assert.equal(heading("Context").getAttribute("aria-expanded"), "true");
        await act(() => app().setActiveId(original));
        assert.equal(heading("Outputs").getAttribute("aria-expanded"), "true");
        assert.equal(heading("Context").getAttribute("aria-expanded"), "false");
      },
      false,
      true,
    );
  });
}

for (const scenario of [
  {
    name: "web phone",
    host: "web",
    opening: 390,
    closing: 390,
    expected: null,
  },
  {
    name: "web desktop → phone",
    host: "web",
    opening: 1440,
    closing: 390,
    expected: null,
  },
  {
    name: "web phone → desktop",
    host: "web",
    opening: 390,
    closing: 1440,
    expected: null,
  },
  {
    name: "native narrow window",
    host: "desktop",
    opening: 390,
    closing: 390,
    expected: "progress",
  },
] as const) {
  test(`${scenario.name}: Close follows overlay/in-flow Activity semantics`, async () => {
    await withHost(
      "chat",
      async ({ app, versions, act, resize }) => {
        resize(scenario.opening);
        await act(() => app().setPanel("progress"));
        await act(() => openArtifact(app(), versions[0]));
        resize(scenario.closing);
        await act(() => viewerProps(app()).onClose());
        assert.equal(app().panel, scenario.expected);
        assert.equal(app().artifact, undefined);
      },
      false,
      false,
      scenario.host,
    );
  });
}

for (const mode of ["chat", "cowork"] as const) {
  test(`${mode}: real Host open/Close restores Activity once`, async () => {
    await withHost(mode, async ({ app, versions, act }) => {
      await act(() => app().setPanel("progress"));
      await act(() => openArtifact(app(), versions[0]));
      assert.equal(app().panel, null);
      // Historical cards still open latest; changing that is a separate policy.
      assert.equal(app().artifact?.id, versions[2].id);
      await act(() => viewerProps(app()).onClose());
      assert.equal(app().artifact, undefined);
      assert.equal(app().panel, "progress");
      assert.equal(
        app().artifactPresentation.current.takeRestore(app().activeId!),
        false,
      );
    });
  });

  test(`${mode}: the real Host title-menu A → B path preserves Activity return`, async () => {
    await withHost(mode, async ({ app, versions, sibling, act }) => {
      await act(() => app().setPanel("progress"));
      await act(() => openArtifact(app(), versions[0]));
      await act(() => viewerProps(app()).onSwitch(sibling));
      assert.equal(app().artifact?.sourcePath, sibling.sourcePath);
      await act(() => viewerProps(app()).onClose());
      assert.equal(app().panel, "progress");
    });
  });
}

for (const mode of ["chat", "cowork", "code"] as const) {
  test(`${mode}: actual ShellMenuHost Close Pane uses the viewer close path`, async () => {
    await withHost(
      mode,
      async ({ app, versions, act, focusCount }) => {
        await act(() => app().setPanel("progress"));
        await act(() => openArtifact(app(), versions[0]));
        await act(() => assert.equal(runShellCommand("close-pane"), true));
        assert.equal(app().artifact, undefined);
        assert.equal(app().panel, mode === "code" ? null : "progress");
        assert.equal(focusCount(), 1);
      },
      true,
    );
    assert.equal(runShellCommand("close-pane"), false);
  });
}

test("viewer switches without prior Activity do not invent an Activity return", async () => {
  await withHost("chat", async ({ app, versions, sibling, act }) => {
    await act(() => openArtifact(app(), versions[0]));
    await act(() => viewerProps(app()).onSwitch(sibling));
    await act(() => viewerProps(app()).onClose());
    assert.equal(app().panel, null);
  });
});

test("cross-conversation viewers clear the old Activity return", async () => {
  await withHost("chat", async ({ app, versions, sibling, act }) => {
    const original = app().activeId!;
    await act(() => app().setPanel("progress"));
    await act(() => openArtifact(app(), versions[0]));
    await act(() => app().setActiveId("other"));
    await act(() =>
      viewerProps(app()).onSwitch({ ...sibling, conversationId: "other" }),
    );
    await act(() => viewerProps(app()).onClose());
    assert.equal(app().panel, null);
    assert.equal(
      app().artifactPresentation.current.takeRestore(original),
      false,
    );
  });
});

test("closing after navigating to another conversation cannot reopen old Activity", async () => {
  await withHost("chat", async ({ app, versions, act }) => {
    const original = app().activeId!;
    await act(() => app().setPanel("progress"));
    await act(() => openArtifact(app(), versions[0]));
    await act(() => app().setActiveId("other"));
    await act(() => viewerProps(app()).onClose());
    assert.equal(app().panel, null);
    assert.equal(
      app().artifactPresentation.current.takeRestore(original),
      false,
    );
  });
});

test("a manual panel change clears return intent even if that panel is later closed", async () => {
  await withHost("chat", async ({ app, versions, sibling, act }) => {
    await act(() => app().setPanel("progress"));
    await act(() => openArtifact(app(), versions[0]));
    // ConversationHeaderHost changes the pane and clears the viewer together.
    await act(() => {
      app().setPanel("plan");
      app().setArtifact(undefined);
    });
    await act(() => app().setPanel(null));
    await act(() => openArtifact(app(), sibling));
    await act(() => viewerProps(app()).onClose());
    assert.equal(app().panel, null);
  });
});

test("an explicit artifact dock restores Activity but never displaces another dock pane", async () => {
  await withHost("chat", async ({ app, versions, sibling, act }) => {
    await act(() => app().setPanel("progress"));
    await act(() => openArtifact(app(), versions[0]));
    await act(() => app().setPanel("artifact"));
    await act(() => viewerProps(app()).onSwitch(sibling));
    await act(() => viewerProps(app()).onClose());
    assert.equal(app().panel, "progress");

    await act(() => openArtifact(app(), versions[0]));
    await act(() => app().setPanel("artifact"));
    await act(() => app().setPanel("files"));
    assert.equal(app().panel, "artifact");
    await act(() => viewerProps(app()).onClose());
    assert.equal(app().panel, "files");
    assert.deepEqual(app().toolPanels.dock, ["files"]);
  });
});

test("Code never gains a non-Code Activity return", async () => {
  await withHost("code", async ({ app, versions, sibling, act }) => {
    await act(() => app().setPanel("progress"));
    await act(() => openArtifact(app(), versions[0]));
    await act(() => viewerProps(app()).onSwitch(sibling));
    await act(() => viewerProps(app()).onClose());
    assert.equal(app().panel, null);
  });
});

test("full FileViewer independently selects v1/v2/v3 for A → B → A and retains document metadata identity", async () => {
  await withDom(async ({ document, render, click }) => {
    const { versions } = fixture("chat", true);
    const latest = { ...versions[2], surface: "file" as const };
    await render(
      createElement(ArtifactPanel, {
        artifact: latest,
        versionsOf: () => versions,
        onClose() {},
        onError(error) {
          throw error;
        },
      }),
    );
    const button = () =>
      document
        .querySelector(".artifact-version-button")!
        .getAttribute("aria-label");
    assert.equal(button(), "Switch artifact version, currently version 3");
    await click('[role="radio"][aria-label="Code"]');
    const source = () =>
      [...document.querySelectorAll(".file-source-line code")]
        .map((line) => line.textContent)
        .join("\n");
    const choose = async (number: number) => {
      await click(".artifact-version-button");
      const row = document.querySelector<HTMLButtonElement>(
        `[role="menuitemradio"][aria-label="Version ${number}${number === 3 ? " · Latest" : ""}"]`,
      )!;
      assert.ok(row);
      await act(() => row.click());
      assert.equal(
        button(),
        `Switch artifact version, currently version ${number}`,
      );
      assert.equal(source(), versions[number - 1].content);
    };
    await choose(1);
    await choose(2);
    await choose(1);
    await choose(3);
    await click(".artifact-version-button");
    assert.equal(
      document
        .querySelector('[role="menuitemradio"][aria-checked="true"]')
        ?.getAttribute("aria-label"),
      "Version 3 · Latest",
    );
    assert.equal(artifactIdentity(versions[0]), artifactIdentity(versions[2]));
    assert.equal(
      artifactNoteKeyOf(versions[0]),
      artifactNoteKeyOf(versions[2]),
    );
    assert.equal(versions[0].id, versions[2].id);
    assert.notEqual(versionIdOf(versions[0]), versionIdOf(versions[2]));
  });
});

test("history refreshes when the file ID, digest and capture time all repeat", async () => {
  await withDom(async ({ document, render }) => {
    const { versions } = fixture("chat", true);
    let history = versions.slice(0, 1);
    const panel = (artifact: Artifact) =>
      createElement(ArtifactPanel, {
        artifact: { ...artifact, updatedAt: 1, surface: "file" },
        versionsOf: () => history,
        onClose() {},
        onError(error) {
          throw error;
        },
      });
    await render(panel(versions[0]));
    assert.equal(document.querySelector(".artifact-version-button"), null);
    history = versions;
    await render(panel(versions[2]));
    assert.equal(
      document
        .querySelector(".artifact-version-button")
        ?.getAttribute("aria-label"),
      "Switch artifact version, currently version 3",
    );
  });
});
