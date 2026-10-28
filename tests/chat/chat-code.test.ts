import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, useRef, useState } from "react";
import type { GitHubRepository } from "../../shared/github-api";
import { webHost } from "../../shared/host";
import { HostContext } from "../../src/host/HostContext";
import { atomicChatDom } from "../support/atomic-chat-dom";

const repository = (name: string): GitHubRepository => ({
  name,
  fullName: `acme/${name}`,
  owner: "acme",
  private: false,
  description: "",
  cloneUrl: `https://github.com/acme/${name}.git`,
  defaultBranch: "main",
});
const connected = { configured: true, connected: true, login: "acme" };

async function click(
  env: Awaited<ReturnType<typeof atomicChatDom>>,
  node: Element,
) {
  await act(async () => {
    node.dispatchEvent(
      new env.window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
}

async function input(
  env: Awaited<ReturnType<typeof atomicChatDom>>,
  node: HTMLInputElement,
  value: string,
) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      env.window.HTMLInputElement.prototype,
      "value",
    )!.set!.call(node, value);
    node.dispatchEvent(new env.window.Event("input", { bubbles: true }));
  });
}

test("shell 60 reused environment menu executes Local download and New environment without inventing cloud profiles", async () => {
  const env = await atomicChatDom();
  const { WebCodeEnvironmentMenu } =
    await import("../../src/composer/WebCodeEnvironmentMenu");
  let downloads = 0,
    creates = 0,
    selections = 0,
    closes = 0;
  function Popup() {
    const [open, setOpen] = useState(true);
    return (
      open &&
      createElement(WebCodeEnvironmentMenu, {
        options: {
          environments: [],
          loaded: true,
          error: new Error("fixture unavailable"),
          onChoose() {
            selections++;
          },
          onEdit() {
            assert.fail("No profile exists");
          },
          onCreate() {
            creates++;
          },
          onDownload() {
            downloads++;
          },
        },
        position: { left: 20, top: 20 },
        anchors: [],
        onClose() {
          closes++;
          setOpen(false);
        },
      })
    );
  }
  try {
    await env.render(createElement(Popup));
    const local = Array.from(env.document.querySelectorAll("button")).find(
      (node) => node.textContent?.startsWith("Local"),
    )!;
    assert.equal(local.getAttribute("role"), "menuitemradio");
    assert.ok(local.textContent?.includes("Desktop only"));
    await click(env, local);
    assert.equal(downloads, 1);
    assert.equal(closes, 1);
    assert.equal(selections, 0);
    await env.render(createElement(Popup, { key: "create" }));
    const create = Array.from(env.document.querySelectorAll("button")).find(
      (node) => node.textContent?.startsWith("New environment"),
    )!;
    await click(env, create);
    assert.equal(creates, 1);
    assert.equal(closes, 2);
    assert.equal(selections, 0);
    await env.render(createElement(Popup, { key: "failure" }));
    const cloud = Array.from(env.document.querySelectorAll("button")).find(
      (node) => node.textContent === "Cloud",
    )!;
    await click(env, cloud);
    const failure = Array.from(env.document.querySelectorAll("button")).find(
      (node) => node.textContent === "Couldn’t load cloud environments",
    )!;
    assert.ok(failure);
    assert.equal(failure.disabled, true);
    await click(env, failure);
    assert.equal(selections, 0);
    assert.equal(closes, 2);
  } finally {
    await env.clean();
  }
});

test("repository search rejects an old query response during the next query's debounce", async () => {
  const requests: {
    query: string;
    resolve: (value: {
      items: GitHubRepository[];
      nextPage: null;
      truncated: false;
    }) => void;
  }[] = [];
  const env = await atomicChatDom({
    githubRepositories: ({ query } = {}) =>
      new Promise((resolve) => {
        requests.push({ query: query ?? "", resolve });
      }),
  });
  const { RepositoryMenu } = await import("../../src/composer/RepositoryMenu");
  const chosen: string[] = [];
  try {
    await env.render(
      createElement(
        HostContext.Provider,
        { value: webHost },
        createElement(RepositoryMenu, {
          combobox: true,
          status: connected,
          left: 0,
          anchor: { current: null },
          onChoose(value) {
            if (value) chosen.push(value.fullName);
          },
          onStatus() {},
          onClose() {},
        }),
      ),
    );
    await env.settle();
    assert.equal(requests.length, 1);
    const search = env.document.querySelector<HTMLInputElement>(
      'input[role="combobox"]',
    )!;
    await input(env, search, "current");
    assert.equal(search.value, "current");
    await act(async () =>
      requests[0].resolve({
        items: [repository("stale")],
        nextPage: null,
        truncated: false,
      }),
    );
    assert.equal(
      env.document.querySelectorAll('[role="option"]').length,
      0,
      "the previous response cannot become selectable under the current search",
    );
    await env.key(search, "ArrowDown");
    await env.key(search, "Enter");
    assert.deepEqual(chosen, []);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 260));
    });
    assert.equal(requests[1].query, "current");
    await act(async () =>
      requests[1].resolve({
        items: [repository("current")],
        nextPage: null,
        truncated: false,
      }),
    );
    assert.equal(
      env.document.querySelector('[role="option"] strong')?.textContent,
      "acme/current",
    );
    await env.key(search, "ArrowDown");
    await env.key(search, "Enter");
    assert.deepEqual(chosen, ["acme/current"]);
  } finally {
    await env.clean();
  }
});

test("shell 60 reused repository footer refreshes data and opens the actual GitHub management destination", async () => {
  let reads = 0,
    closes = 0;
  const env = await atomicChatDom({
    githubRepositories: async () => ({
      items: [repository(++reads === 1 ? "first" : "refreshed")],
      nextPage: null,
      truncated: false,
    }),
  });
  const { RepositoryMenu } = await import("../../src/composer/RepositoryMenu");
  const {
    settingsNavigationEvent,
    readSettingsConnectorTarget,
    takeSettingsConnectorTarget,
  } = await import("../../src/settings/navigation");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "CustomEvent");
  Object.defineProperty(globalThis, "CustomEvent", {
    configurable: true,
    value: env.window.CustomEvent,
  });
  const navigations: string[] = [];
  env.window.addEventListener(settingsNavigationEvent, (event) => {
    navigations.push((event as CustomEvent<string>).detail);
  });
  function Picker() {
    const [open, setOpen] = useState(true);
    const anchor = useRef<HTMLButtonElement>(null);
    return createElement(
      HostContext.Provider,
      { value: webHost },
      createElement("button", { ref: anchor }, "Add repository"),
      open &&
        createElement(RepositoryMenu, {
          combobox: true,
          status: connected,
          left: 0,
          anchor,
          onChoose() {},
          onStatus() {},
          onClose() {
            closes++;
            setOpen(false);
          },
        }),
    );
  }
  try {
    await env.render(createElement(Picker));
    await env.settle();
    assert.equal(
      env.document.querySelector('[role="option"] strong')?.textContent,
      "acme/first",
    );
    const footer = env.document.querySelector(".repository-combobox-footer")!;
    await click(env, footer.querySelector("button")!);
    assert.equal(reads, 2);
    assert.equal(
      env.document.querySelector('[role="option"] strong')?.textContent,
      "acme/refreshed",
    );
    const manage = footer.querySelector("a")!;
    assert.equal(manage.getAttribute("aria-label"), "Manage GitHub connection");
    assert.equal(
      manage.getAttribute("href"),
      "/customize/connectors/yours/id/integration-github?src=repo_picker",
    );
    await click(env, manage);
    assert.deepEqual(navigations, ["connectors"]);
    assert.equal(readSettingsConnectorTarget(), "integration-github");
    assert.equal(
      new URL(env.window.location.href).searchParams.get("connector"),
      "integration-github",
    );
    assert.equal(closes, 1);
    assert.equal(env.document.querySelector('[role="dialog"]'), null);
  } finally {
    takeSettingsConnectorTarget();
    if (previous) Object.defineProperty(globalThis, "CustomEvent", previous);
    else Reflect.deleteProperty(globalThis, "CustomEvent");
    await env.clean();
  }
});
