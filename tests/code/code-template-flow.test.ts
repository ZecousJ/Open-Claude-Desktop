import test from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { routineDom } from "../support/routine-dom";
import { startCodeTemplate } from "../../src/artifacts/start-code-template";
import { CodeOutputIntent } from "../../src/composer/CodeOutputIntent";
import { codeOutputPlaceholder } from "../../src/composer/code-output-model";
import { NavCreatePopup } from "../../src/sidebar/NavCreatePopup";
import { AppContext, type AppController } from "../../src/app/AppContext";
import {
  artifactOutputKinds,
  artifactOutputInstructions,
} from "../../shared/artifact-output";
import { sendDraft } from "../../src/app/composer-send";
import { setSessionCodePermission } from "../../src/app/code-permission-state";

test("all Code template kinds preserve a home draft and open an empty draft from an existing session", () => {
  const prior = Object.getOwnPropertyDescriptor(
    globalThis,
    "requestAnimationFrame",
  );
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (run: () => void) => run(),
  });
  try {
    for (const kind of artifactOutputKinds) {
      let opened = 0,
        selected: string | undefined;
      const app = {
        mode: "code",
        page: "chat",
        text: "keep synthetic text",
        composer: { current: { focus() {} } },
        composerDraft: {
          setDraftArtifactOutput: (value: string) => {
            selected = value;
          },
        },
        newChat: (
          mode: string,
          _project: unknown,
          _incognito: unknown,
          afterStart?: () => void,
        ) => {
          assert.equal(mode, "code");
          opened++;
          app.text = "";
          afterStart?.();
        },
      } as unknown as AppController;
      assert.equal(startCodeTemplate(app, kind), true);
      assert.equal(opened, 0);
      assert.equal(selected, kind);
      assert.equal(app.text, "keep synthetic text");
      app.active = { id: "old" } as never;
      startCodeTemplate(app, kind);
      assert.equal(opened, 1);
      assert.equal(app.text, "");
      assert.ok(codeOutputPlaceholder(kind));
      assert.match(
        artifactOutputInstructions(kind)!,
        /actual requested artifact as files/,
      );
      app.mode = "chat";
      assert.equal(startCodeTemplate(app, kind), false);
      assert.equal(opened, 1);
    }
    assert.equal(artifactOutputInstructions("bogus" as never), undefined);
    let resume: (() => void) | undefined,
      started = 0,
      output: string | undefined;
    const waiting = {
      mode: "code",
      page: "chat",
      active: { id: "dirty" },
      composer: { current: { focus() {} } },
      newChat: (
        _mode: unknown,
        _project: unknown,
        _incognito: unknown,
        afterStart?: () => void,
      ) => {
        resume = () => {
          started++;
          afterStart?.();
        };
      },
      composerDraft: {
        setDraftArtifactOutput(value: string) {
          output = value;
        },
      },
    } as unknown as AppController;
    startCodeTemplate(waiting, "docs");
    assert.equal(started, 0);
    assert.equal(output, undefined);
    assert.ok(resume);
    resume();
    assert.equal(started, 1);
    assert.equal(output, "docs");
  } finally {
    if (prior)
      Object.defineProperty(globalThis, "requestAnimationFrame", prior);
    else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
  }
});

test("actual output chip opens the324px top menu and removes only the selected output", async () => {
  const dom = await routineDom();
  const globals = { innerWidth: 900, innerHeight: 669 };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const proto = dom.window.HTMLElement.prototype,
    box = Object.getOwnPropertyDescriptor(proto, "getBoundingClientRect");
  proto.getBoundingClientRect = () => ({
    x: 371,
    y: 589,
    left: 371,
    top: 589,
    right: 464,
    bottom: 617,
    width: 93,
    height: 28,
    toJSON() {
      return {};
    },
  });
  let removed = 0;
  try {
    await dom.render(
      h(CodeOutputIntent, {
        kind: "docs",
        onRemove: () => {
          removed++;
        },
      }),
    );
    const chip = dom.document.querySelector(
      '[aria-label="Output: Claudex Docs"]',
    )!;
    assert.equal(chip.getAttribute("aria-pressed"), "true");
    await dom.event(chip, "click");
    const menu = dom.document.querySelector<HTMLElement>('[role="menu"]')!;
    assert.ok(menu.classList.contains("code-output-remove-menu"));
    assert.equal(menu.style.width, "324px");
    assert.equal(menu.style.bottom, "86px");
    const remove = [...menu.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Remove document"),
    )!;
    await dom.event(remove, "click");
    assert.equal(removed, 1);
  } finally {
    await dom.clean();
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
    if (box) Object.defineProperty(proto, "getBoundingClientRect", box);
    else Reflect.deleteProperty(proto, "getBoundingClientRect");
  }
});

test("actual Code template popup selects an output without submitting or pre-filling a message", async () => {
  const dom = await routineDom();
  const priorWidth = Object.getOwnPropertyDescriptor(globalThis, "innerWidth"),
    priorHeight = Object.getOwnPropertyDescriptor(globalThis, "innerHeight");
  Object.defineProperty(globalThis, "innerWidth", {
    configurable: true,
    value: 900,
  });
  Object.defineProperty(globalThis, "innerHeight", {
    configurable: true,
    value: 669,
  });
  let selected: string | undefined,
    opened = 0;
  const app = {
    mode: "code",
    page: "chat",
    text: "keep draft",
    sidebarView: { phone: false },
    composer: { current: { focus() {} } },
    composerDraft: {
      setDraftArtifactOutput: (kind: string) => {
        selected = kind;
      },
    },
    newChat() {
      opened++;
    },
    setText() {
      throw Error("must not prefill");
    },
  } as unknown as AppController;
  try {
    await dom.render(
      h(
        AppContext.Provider,
        { value: app },
        h(NavCreatePopup, {
          kind: "artifacts",
          position: { left: 10, top: 10 },
          anchor: { current: null },
          onClose() {},
        }),
      ),
    );
    assert.match(
      dom.document.body.textContent!,
      /Nothing is created until you send/,
    );
    const docs = [...dom.document.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent?.includes("Docs"),
    )!;
    await dom.event(docs, "click");
    assert.equal(selected, "docs");
    assert.equal(opened, 0);
    assert.equal(app.text, "keep draft");
  } finally {
    await dom.clean();
    if (priorWidth) Object.defineProperty(globalThis, "innerWidth", priorWidth);
    else Reflect.deleteProperty(globalThis, "innerWidth");
    if (priorHeight)
      Object.defineProperty(globalThis, "innerHeight", priorHeight);
    else Reflect.deleteProperty(globalThis, "innerHeight");
  }
});

test("the real composer send forwards output and negotiated permission metadata and retains draft choices on failure", async () => {
  for (const supported of [false, true])
    for (const initialPermission of [undefined, "plan"] as const)
      for (const queued of [false, true])
        for (const fail of [false, true]) {
          let request: any,
            kind: any = "docs",
            permission: any = initialPermission,
            reported = 0;
          const dom = await routineDom({
            send: async (input) => {
              request = input;
              if (fail) throw Error("synthetic failure");
              return { id: "new", mode: "code", turns: [] } as never;
            },
          });
          const app = {
            text: "Write a short document",
            attachments: [],
            mode: "code",
            sending: false,
            running: false,
            model: "test-model",
            providerId: "p",
            policy: { webSearch: false },
            snapshot: {
              settings: {},
              host: {
                kind: "web",
                capabilities: { codeSessionPermissions: supported },
              },
            },
            composerDraft: {
              draftArtifactOutput: "docs",
              draftCodePermissionMode: initialPermission,
              getDraftCodePermissionMode: () => permission,
              setDraftCodePermissionMode: (value: any) => {
                permission =
                  typeof value === "function" ? value(permission) : value;
              },
              draftKnowledge: [],
              draftConnectors: {},
              draftAdditionalFolders: [],
              setDraftLinearIssue() {},
              setDraftAdditionalFolders() {},
              setDraftArtifactOutput: (value: any) => {
                kind = typeof value === "function" ? value(kind) : value;
              },
            },
            navigation: { replaceNext() {} },
            selectNext: { current: false },
            follow: { current: false },
            composer: { current: { focus() {}, blur() {} } },
            setSending() {},
            setError() {},
            setText: (value: string) => {
              app.text = value;
            },
            setAttachments() {},
            upsert() {},
            setActiveId() {},
            setPage() {},
            notify() {},
            report() {
              reported++;
            },
          } as unknown as AppController;
          try {
            const pending =
              queued && supported && initialPermission === undefined
                ? setSessionCodePermission(app, {
                    codeSandbox: "read-only",
                    autoAcceptEdits: false,
                    codePlanMode: true,
                  })
                : undefined;
            await sendDraft(app);
            await pending;
            const selected = pending ? "plan" : initialPermission;
            assert.equal(request.text, "Write a short document");
            assert.equal(request.artifactOutputKind, "docs");
            assert.equal(
              request.codePermissionMode,
              supported ? (selected ?? "auto") : undefined,
            );
            assert.equal(permission, supported && !fail ? undefined : selected);
            assert.equal(kind, fail ? "docs" : undefined);
            assert.equal(app.text, fail ? "Write a short document" : "");
            assert.equal(reported, fail ? 1 : 0);
          } finally {
            await dom.clean();
          }
        }
});
