import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { desktopHost, webHost } from "../../shared/host";
import { lockedPolicy, openPolicy } from "../../shared/client-policy";
import { HostContext } from "../../src/host/HostContext";
import {
  CodePermissionPicker,
  offeredPermissionChoices,
  webCodePermissionChoices,
} from "../../src/composer/code/CodePermissionPicker";

test("web modes project the actual supported, policy-filtered rows in captured order", () => {
  const ids = (
    policy: typeof openPolicy,
    supported?: Parameters<typeof offeredPermissionChoices>[3],
  ) =>
    webCodePermissionChoices(
      offeredPermissionChoices(policy, "darwin", true, supported),
    ).map((row) => row.id);
  assert.deepEqual(ids(openPolicy), ["auto", "acceptEdits", "plan"]);
  assert.deepEqual(ids(lockedPolicy), ["plan"]);
  assert.deepEqual(ids(openPolicy, ["auto", "plan"]), ["auto", "plan"]);
  assert.deepEqual(ids(openPolicy, ["manual", "bypass"]), []);
  // The mode the trigger shows always has its checked row.
  const offered = offeredPermissionChoices(openPolicy, "darwin", true);
  assert.deepEqual(
    webCodePermissionChoices(offered, "manual").map((row) => row.id),
    ["auto", "acceptEdits", "plan", "manual"],
  );
  assert.deepEqual(
    webCodePermissionChoices(offered, "plan").map((row) => row.id),
    ["auto", "acceptEdits", "plan"],
  );
  // The native projection, including the user's opted-in Bypass, is unchanged.
  assert.deepEqual(
    offeredPermissionChoices(openPolicy, "darwin", true).map((row) => row.id),
    ["manual", "acceptEdits", "plan", "auto", "bypass"],
  );
});

test("actual Code permission picker opens web inline radios, applies a mode, and keeps native glyph rows", async () => {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    innerHeight: globalThis.innerHeight,
    innerWidth: globalThis.innerWidth,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT,
  };
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  (document as unknown as { oninput: null }).oninput = null;
  let focused: HTMLElement | undefined;
  const oldFocus = window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus = function () {
    focused = this;
  };
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => focused ?? document.body,
  });
  Object.assign(globalThis, {
    window,
    document,
    innerHeight: 900,
    innerWidth: 1440,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const changes: unknown[] = [];
  const render = async (web: boolean) => {
    await act(async () =>
      root.render(
        createElement(
          HostContext.Provider,
          { value: web ? webHost : desktopHost },
          createElement(CodePermissionPicker, {
            platform: "darwin",
            sandbox: "workspace-write",
            autoAcceptEdits: false,
            planMode: false,
            onChange: (patch) => changes.push(patch),
            onUnavailable: assert.fail,
          }),
        ),
      ),
    );
    const trigger = document.querySelector<HTMLButtonElement>(
      ".code-permission-trigger",
    )!;
    trigger.focus();
    await act(async () =>
      trigger.dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    return trigger;
  };
  try {
    const trigger = await render(true);
    assert.equal(trigger.getAttribute("aria-label"), "Permissions: Auto");
    const menu = document.querySelector(".web-code-permission-menu")!;
    const body = menu.querySelector(".web-code-permission-body")!;
    assert.equal(body.parentElement, menu);
    assert.equal(menu.children.length, 1);
    assert.equal((menu as HTMLElement).style.width, "261px");
    assert.equal(
      menu.querySelector(".menu-heading")?.textContent,
      "Permission mode",
    );
    const radios = Array.from(menu.querySelectorAll('[role="menuitemradio"]'));
    assert.deepEqual(
      radios.map(
        (row) => row.querySelector(".menu-item-text > span")?.textContent,
      ),
      ["Auto", "Accept edits", "Plan"],
    );
    assert.equal(radios[0].getAttribute("aria-checked"), "true");
    assert.equal(menu.querySelectorAll(".menu-description").length, 3);
    assert.equal(menu.querySelectorAll(".menu-icon").length, 0);
    await act(async () =>
      radios[1].dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    assert.deepEqual(changes, [
      {
        codeSandbox: "workspace-write",
        autoAcceptEdits: true,
        codePlanMode: false,
      },
    ]);
    assert.equal(document.querySelector(".web-code-permission-menu"), null);
    assert.equal(focused, trigger);

    await render(false);
    const native = document.querySelector(".permission-mode-menu")!;
    assert.ok(!native.classList.contains("web-code-permission-menu"));
    assert.equal(native.querySelector(".menu-heading"), null);
    assert.equal(native.querySelectorAll(".menu-description").length, 0);
    assert.equal(native.querySelectorAll(".menu-icon").length, 5);
    assert.ok(
      Array.from(native.children).every((child) => child.tagName === "BUTTON"),
    );
    const escape = new window.Event("keydown", {
      bubbles: true,
      cancelable: true,
    });
    Object.assign(escape, { key: "Escape" });
    await act(async () => native.dispatchEvent(escape));
    assert.equal(document.querySelector(".permission-mode-menu"), null);
    assert.equal(focused, trigger);
  } finally {
    await act(async () => root.unmount());
    window.HTMLElement.prototype.focus = oldFocus;
    Object.assign(globalThis, previous);
  }
});
