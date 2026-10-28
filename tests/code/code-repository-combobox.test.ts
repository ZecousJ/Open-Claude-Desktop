import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, useRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { GitHubRepository } from "../../shared/github-api";
import { webHost } from "../../shared/host";
import { HostContext } from "../../src/host/HostContext";
import { maxCodeRepositories } from "../../src/composer/code-repository";

const repositories: GitHubRepository[] = ["app", "lib", "tools"].map(
  (name) => ({
    name,
    fullName: `acme/${name}`,
    owner: "acme",
    private: false,
    description: "A repository description",
    cloneUrl: `https://github.com/acme/${name}.git`,
    defaultBranch: "main",
  }),
);

test("the web Code draft repository combobox navigates, selects, and restores focus", async () => {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT,
  };
  const { window, document } = parseHTML(
    '<html><body><button id="trigger">Repo</button><main id="root"></main></body></html>',
  );
  (document as unknown as { oninput: null }).oninput = null;
  let focused = 0;
  const trigger = document.getElementById("trigger")!;
  trigger.focus = () => {
    focused++;
  };
  window.desktop = {
    githubRepositories: async ({ query }: { query?: string }) => ({
      items: repositories.filter((repository) =>
        repository.fullName.includes(query ?? ""),
      ),
      nextPage: null,
      truncated: false,
    }),
  } as unknown as Window["desktop"];
  Object.assign(globalThis, {
    window,
    document,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { RepositoryMenu } = await import("../../src/composer/RepositoryMenu");
  const root = createRoot(document.getElementById("root")!);
  const picked: string[] = [];
  let closes = 0;
  const props = {
    combobox: true,
    popupId: "repository-popup",
    status: { configured: true, connected: true, login: "acme" },
    left: 0,
    anchor: { current: trigger },
    selected: ["acme/app"],
    onChoose(repository: GitHubRepository | undefined) {
      picked.push(repository?.fullName ?? "");
    },
    onStatus() {},
    onClose() {
      closes++;
    },
  };
  const key = async (value: string) => {
    const input = document.querySelector('input[role="combobox"]')!;
    const event = new window.Event("keydown", {
      bubbles: true,
      cancelable: true,
    });
    Object.assign(event, { key: value });
    await act(async () => {
      input.dispatchEvent(event);
    });
  };
  try {
    await act(async () => {
      root.render(
        createElement(
          HostContext.Provider,
          { value: webHost },
          createElement(RepositoryMenu, props),
        ),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    assert.equal(
      document.querySelector('[role="dialog"]')?.id,
      "repository-popup",
    );
    const input = document.querySelector('input[role="combobox"]')!;
    const list = document.querySelector('[role="listbox"]')!;
    assert.equal(input.getAttribute("aria-controls"), list.id);
    assert.equal(input.getAttribute("aria-haspopup"), "listbox");
    assert.equal(list.getAttribute("aria-multiselectable"), "true");
    assert.equal(list.querySelectorAll('[role="option"]').length, 3);
    assert.equal(
      list
        .querySelector('[aria-selected="true"]')
        ?.getAttribute("aria-disabled"),
      "true",
    );

    await key("ArrowDown");
    let active = document.getElementById(
      input.getAttribute("aria-activedescendant")!,
    );
    assert.equal(active?.querySelector("strong")?.textContent, "acme/lib");
    assert.equal(active?.getAttribute("data-highlighted"), "true");
    await key("ArrowUp");
    active = document.getElementById(
      input.getAttribute("aria-activedescendant")!,
    );
    assert.equal(active?.querySelector("strong")?.textContent, "acme/tools");
    await key("Enter");
    assert.deepEqual(picked, ["acme/tools"]);
    assert.equal(focused, 1);

    // The last selected repository is protected from pointer selection too.
    await act(async () => {
      list
        .querySelector('[aria-disabled="true"]')!
        .dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    assert.deepEqual(picked, ["acme/tools"]);
    await key("Escape");
    assert.equal(closes, 1);
    assert.equal(focused, 2);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
});

test("the native and standalone repository menu retains its menu structure", async () => {
  const { RepositoryMenu } = await import("../../src/composer/RepositoryMenu");
  const markup = renderToStaticMarkup(
    createElement(RepositoryMenu, {
      status: { configured: true, connected: true, login: "acme" },
      left: 0,
      anchor: { current: null },
      onChoose() {},
      onStatus() {},
      onClose() {},
    }),
  );
  assert.match(markup, /role="menu" aria-label="Repository"/);
  assert.doesNotMatch(markup, /role="dialog"|role="combobox"|role="listbox"/);
});

test("choosing the tenth repository restores keyboard focus after Add is removed", async () => {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT,
  };
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  let focused: HTMLElement | undefined;
  const oldFocus = window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus = function () {
    focused = this;
  };
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => focused ?? document.body,
  });
  const frames: FrameRequestCallback[] = [];
  window.desktop = {
    githubRepositories: async () => ({
      items: [repositories[0]],
      nextPage: null,
      truncated: false,
    }),
  } as never;
  Object.assign(globalThis, {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    },
  });
  const { createRoot } = await import("react-dom/client");
  const { RepositoryMenu } = await import("../../src/composer/RepositoryMenu");
  const root = createRoot(document.querySelector("main")!);
  let fallbackRequests = 0;
  function AtRepositoryLimit() {
    const [count, setCount] = useState(maxCodeRepositories - 1);
    const add = useRef<HTMLButtonElement>(null),
      chosen = useRef<HTMLButtonElement>(null);
    return createElement(
      "div",
      null,
      count < maxCodeRepositories &&
        createElement(
          "button",
          { ref: add, "data-add": true },
          "Add repository",
        ),
      count === maxCodeRepositories &&
        createElement(
          "button",
          { ref: chosen, "data-selected-repository": true },
          repositories[0].fullName,
        ),
      count < maxCodeRepositories &&
        createElement(RepositoryMenu, {
          combobox: true,
          status: { configured: true, connected: true, login: "acme" },
          left: 0,
          anchor: add,
          selected: Array.from(
            { length: count },
            (_, index) => `acme/r${index}`,
          ),
          onChoose(repository) {
            assert.equal(repository?.fullName, repositories[0].fullName);
            setCount(count + 1);
          },
          focusFallback(repository) {
            assert.equal(repository.fullName, repositories[0].fullName);
            fallbackRequests++;
            return chosen.current;
          },
          onStatus() {},
          onClose() {},
        }),
    );
  }
  const key = async (value: string) => {
    const event = new window.Event("keydown", {
      bubbles: true,
      cancelable: true,
    });
    Object.assign(event, { key: value });
    await act(async () =>
      document.querySelector('input[role="combobox"]')!.dispatchEvent(event),
    );
  };
  try {
    assert.equal(maxCodeRepositories, 10);
    await act(async () => root.render(createElement(AtRepositoryLimit)));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    await key("ArrowDown");
    await key("Enter");
    assert.equal(document.querySelector("[data-add]"), null);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await act(async () => {
      for (const callback of frames.splice(0)) callback(0);
    });
    assert.equal(fallbackRequests, 1);
    assert.equal(
      document.activeElement,
      document.querySelector("[data-selected-repository]"),
    );
    assert.notEqual(document.activeElement, document.body);
    assert.equal(document.activeElement?.isConnected, true);
  } finally {
    await act(async () => root.unmount());
    window.HTMLElement.prototype.focus = oldFocus;
    Object.assign(globalThis, previous);
  }
});

test("the current picker footer is one row with Refresh and an internal Manage link", async () => {
  const fs = await import("node:fs");
  const postcss = (await import("postcss")).default;
  const sheet = postcss.parse(
    fs.readFileSync("src/composer/repository-menu.css", "utf8"),
  );
  const values: Record<string, string> = {};
  sheet.walkRules(
    ".app.web .web-code-draft .repository-combobox-footer > button",
    (rule) => {
      rule.walkDecls((d) => {
        values[d.prop] = d.value;
      });
    },
  );
  assert.equal(values.height, "24px");
  assert.equal(values["min-height"], "24px");
  assert.equal(values.margin, "0");
  const source = fs.readFileSync("src/composer/RepositoryMenu.tsx", "utf8");
  assert.match(source, /className="repository-combobox-footer"/);
  assert.match(
    source,
    /href="\/customize\/connectors\/yours\/id\/integration-github\?src=repo_picker"/,
  );
  assert.match(
    source,
    /openSettingsLink\("connectors",\s*"integration-github"\)/,
  );
});
