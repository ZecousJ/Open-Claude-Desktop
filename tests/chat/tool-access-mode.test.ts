import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { codexModelCatalog } from "../../electron/engine/codex-model-catalog";
import { defaultSettings } from "../../electron/store/store";
import { CapabilitiesTab } from "../../src/settings/tabs/Capabilities";
import { PrivacyTab } from "../../src/settings/tabs/Privacy";
import { preference } from "../../shared/settings-extras";
import type { Settings } from "../../shared/types";
import type { TabProps } from "../../src/settings/context";
import { HostContext } from "../../src/host/HostContext";
import { hostFor } from "../../shared/host";

test("Tools already loaded turns tool search off for every model", () => {
  const searching = codexModelCatalog().models.filter(
    (model) => model.supports_search_tool,
  );
  // Codex's own models search their tools by default.
  assert.ok(searching.length > 0);
  const loaded = codexModelCatalog({ preloadTools: true }).models;
  assert.ok(loaded.every((model) => model.supports_search_tool === false));
  assert.equal(loaded.length, codexModelCatalog().models.length);
});

test("the mode defaults to loading tools when needed", () => {
  assert.equal(preference({} as never, "toolAccessMode"), "needed");
});

test("Capabilities offers Tool access mode and shows security guidance for the actual host", () => {
  const html = renderToStaticMarkup(
    createElement(CapabilitiesTab, {
      settings: { toolAccessMode: "loaded" },
      save: async () => true,
      goTo() {},
      // Windows keeps Chat's code offline (shared/local-egress.ts).
      platform: "win32",
    } as unknown as TabProps),
  );
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const field = document.querySelector('[aria-label="Tool access mode"]');
  assert.ok(field?.textContent?.includes("Tools already loaded"));
  assert.equal(field?.hasAttribute("disabled"), false);
  assert.ok(
    Array.from(document.querySelectorAll("a[href]")).some(
      (link) =>
        link.getAttribute("href")?.endsWith("/help/files-and-code") &&
        link.textContent === "security risks",
    ),
  );
  assert.equal(document.querySelector(".capabilities-network"), null);
  assert.ok(
    document.documentElement.textContent?.includes(
      "Network restrictions are available only in a supported cloud sandbox.",
    ),
  );
});

const webPage = (settings: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(
      HostContext.Provider,
      { value: { ...hostFor("web"), sandboxNetwork: "full" } },
      createElement(CapabilitiesTab, {
        settings: { networkEgress: true, ...settings },
        save: async () => true,
        goTo() {},
      } as unknown as TabProps),
    ),
  );

test("each domain allowlist choice has the original's note; None takes your domains", () => {
  const packages = webPage({ egressAllowlist: "packages" });
  assert.match(
    packages,
    /plus any additional domains you specify below\. <a [^>]*help\/cloud-environments[^>]*>View package manager domains<\/a>/,
  );
  assert.match(packages, /Additional allowed domains/);
  const none = webPage({
    egressAllowlist: "none",
    egressDomains: ["api.example.com"],
  });
  assert.match(none, /can only access domains you specify below/);
  // None lists the added domains, each with its remove button.
  assert.match(
    none,
    /<bdi dir="ltr">api\.example\.com<\/bdi><button type="button" aria-label="Remove api\.example\.com"/,
  );
  const all = webPage({ egressAllowlist: "all" });
  assert.match(all, /can access all domains on the internet/);
  assert.doesNotMatch(all, /Additional allowed domains/);
});

test("Location metadata belongs to Privacy, retains its coarse-location help and saves both switch states", async () => {
  const html = renderToStaticMarkup(
    createElement(CapabilitiesTab, {
      settings: {},
      save: async () => true,
      goTo() {},
    } as unknown as TabProps),
  );
  assert.doesNotMatch(
    html,
    /data-setting="Location metadata"|aria-label="Location metadata"/,
  );
  assert.doesNotMatch(
    webPage({}),
    /data-setting="Location metadata"|aria-label="Location metadata"/,
  );

  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  window.desktop = {
    reportingStatus: async () => null,
    sharingStatus: async () => null,
    signUpProfile: async () => null,
    onEvent: () => () => {},
  } as never;
  const globals = { window, document, IS_REACT_ACT_ENVIRONMENT: true };
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

  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  let settings = { ...defaultSettings };
  const changes: Partial<Settings>[] = [];
  let finishSave: () => void;
  const save: TabProps["save"] = (patch) => {
    changes.push(patch);
    return new Promise<boolean>((resolve) => {
      finishSave = () => {
        settings = { ...settings, ...patch };
        draw();
        resolve(true);
      };
    });
  };
  const draw = () =>
    root.render(
      createElement(PrivacyTab, {
        settings,
        save,
        platform: "darwin",
        engine: { state: "ready" },
        goTo() {},
        onError(error: unknown) {
          throw error;
        },
      }),
    );
  try {
    await act(async () => draw());
    const row = document.querySelector('[data-setting="Location metadata"]');
    assert.ok(row);
    assert.equal(
      document.querySelectorAll('[data-setting="Location metadata"]').length,
      1,
    );
    assert.match(
      row.querySelector(".settings-row-text p")!.textContent!,
      /coarse location metadata \(city\/region\) to improve product experiences/,
    );
    const help = row.querySelector("a");
    assert.ok(help);
    assert.equal(help.textContent, "Learn more");
    assert.match(help.getAttribute("href")!, /\/help\/location-metadata$/);
    assert.equal(help.getAttribute("target"), "_blank");

    const toggle = () => {
      const button = row.querySelector<HTMLButtonElement>(
        'button[role="switch"][aria-label="Location metadata"]',
      );
      assert.ok(button);
      return button;
    };
    assert.equal(toggle().getAttribute("aria-checked"), "true");
    assert.equal(toggle().disabled, false);
    for (const next of [false, true]) {
      await act(async () => toggle().click());
      assert.deepEqual(changes.at(-1), { locationMetadata: next });
      assert.equal(toggle().disabled, true);
      await act(async () => finishSave());
      assert.equal(toggle().getAttribute("aria-checked"), String(next));
      assert.equal(toggle().disabled, false);
    }
    assert.deepEqual(changes, [
      { locationMetadata: false },
      { locationMetadata: true },
    ]);
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
