import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, StrictMode, type ReactNode } from "react";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { desktopHost, webHost, type HostInfo } from "../../shared/host";
import type { DesktopAPI } from "../../shared/types";
import type { GitHubStatus } from "../../shared/github-api";
import { HostContext } from "../../src/host/HostContext";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { GitHubConnectionDetail } from "../../src/settings/tabs/GitHubConnectionDetail";
import { githubConnectionChanged } from "../../src/github/connection-events";
import {
  chooseCodeRepository,
  currentCodeRepositories,
} from "../../src/composer/code-repository";

const connected: GitHubStatus = {
  configured: true,
  connected: true,
  login: "actual-login",
};
const disconnected: GitHubStatus = { configured: true, connected: false };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function page(bridge: Partial<DesktopAPI>, host: HostInfo = webHost) {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  window.desktop = bridge as DesktopAPI;
  const redirects: string[] = [];
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      href: "https://fixture.invalid/code",
      origin: "https://fixture.invalid",
      assign: (url: string) => redirects.push(url),
    },
  });
  const values = { window, document, IS_REACT_ACT_ENVIRONMENT: true };
  const before = new Map(
    Object.keys(values).map((k) => [
      k,
      Object.getOwnPropertyDescriptor(globalThis, k),
    ]),
  );
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const root = createRoot(document.querySelector("main")!);
  let backs = 0;
  const render = async (accountId = "one", body?: ReactNode) =>
    act(async () =>
      root.render(
        createElement(
          HostContext.Provider,
          { value: host },
          createElement(
            AppContext.Provider,
            { value: { accountId } as AppController },
            body ??
              createElement(GitHubConnectionDetail, {
                onBack: () => {
                  backs++;
                },
              }),
          ),
        ),
      ),
    );
  const settle = async () =>
    act(async () => {
      await Promise.resolve();
    });
  return {
    document,
    window,
    redirects,
    render,
    settle,
    get backs() {
      return backs;
    },
    async click(label: string) {
      const button = [...document.querySelectorAll("button")].find(
        (e) => e.textContent === label,
      );
      assert.ok(button, label);
      await act(async () => button.click());
    },
    async dispose() {
      await act(async () => root.unmount());
      for (const [key, value] of before) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("GitHub account detail uses live identity and a confirmed disconnect invalidates the picker; stale reads cannot reconnect it", async () => {
  const refresh = deferred<GitHubStatus>(),
    disconnect = deferred<GitHubStatus>();
  let reads = 0,
    disconnects = 0,
    signals = 0;
  const env = await page({
    githubStatus: async () => (++reads === 1 ? connected : refresh.promise),
    githubDisconnect: async () => {
      disconnects++;
      return disconnect.promise;
    },
  });
  env.window.addEventListener(githubConnectionChanged, () => {
    signals++;
  });
  try {
    await env.render();
    await env.settle();
    assert.equal(
      env.document.querySelector("h2")?.textContent,
      "GitHub Integration",
    );
    assert.match(
      env.document.querySelector("[role=status]")!.textContent!,
      /@actual-login/,
    );
    assert.doesNotMatch(
      env.document.body.textContent!,
      /Install on another account|Needs reconnecting|Personal/,
    );
    chooseCodeRepository({
      fullName: "actual/repo",
      url: "https://github.com/actual/repo.git",
      defaultBranch: "main",
      branch: "main",
    });
    await act(async () =>
      env.window.dispatchEvent(new env.window.Event("focus")),
    );
    await env.click("Disconnect");
    await env.click("Disconnecting…");
    assert.equal(disconnects, 1);
    assert.equal(signals, 0);
    await act(async () => disconnect.resolve(disconnected));
    await env.settle();
    assert.match(
      env.document.querySelector("[role=status]")!.textContent!,
      /not connected/,
    );
    assert.equal(signals, 1);
    assert.deepEqual(currentCodeRepositories(), []);
    await act(async () => refresh.resolve(connected));
    await env.settle();
    assert.match(
      env.document.querySelector("[role=status]")!.textContent!,
      /not connected/,
    );
  } finally {
    chooseCodeRepository(undefined);
    await env.dispose();
  }
});

test("a GitHub load failure stays retryable and cannot fabricate a disconnected/unconfigured account", async () => {
  let reads = 0;
  const env = await page({
    githubStatus: async () => {
      if (++reads === 1) throw Error("Status unavailable");
      return connected;
    },
  });
  try {
    await env.render();
    await env.settle();
    assert.match(
      env.document.querySelector("[role=alert]")!.textContent!,
      /Status unavailable/,
    );
    assert.equal(
      env.document.querySelector(".github-connection-account"),
      null,
    );
    await env.click("Try again");
    await env.settle();
    assert.match(
      env.document.querySelector("[role=status]")!.textContent!,
      /account connected/,
    );
    assert.equal(env.document.querySelector("[role=alert]"), null);
  } finally {
    await env.dispose();
  }
});

test("Connect is explicit and uses the existing web redirect / native browser authorization flow", async () => {
  for (const host of [webHost, desktopHost]) {
    const opened: string[] = [];
    let connects = 0;
    const env = await page(
      {
        githubStatus: async () => disconnected,
        githubConnect: async () => {
          connects++;
          return {
            authorizeUrl:
              "https://github.com/login/oauth/authorize?state=fixture",
          };
        },
        openExternal: async (url) => {
          opened.push(url);
        },
      },
      host,
    );
    try {
      await env.render();
      await env.settle();
      assert.equal(connects, 0);
      await env.click("Connect GitHub");
      assert.equal(connects, 1);
      assert.deepEqual(host.kind === "desktop" ? opened : env.redirects, [
        "https://github.com/login/oauth/authorize?state=fixture",
      ]);
      assert.deepEqual(host.kind === "desktop" ? env.redirects : opened, []);
    } finally {
      await env.dispose();
    }
  }
});

test("an old account's disconnect response cannot clear a new account's repository or status", async () => {
  const old = deferred<GitHubStatus>();
  let reads = 0,
    signals = 0;
  const env = await page({
    githubStatus: async () => ({
      ...connected,
      login: ++reads === 1 ? "one" : "two",
    }),
    githubDisconnect: async () => old.promise,
  });
  env.window.addEventListener(githubConnectionChanged, () => {
    signals++;
  });
  try {
    await env.render();
    await env.settle();
    await env.click("Disconnect");
    await env.render("two");
    await env.settle();
    chooseCodeRepository({
      fullName: "two/repo",
      url: "https://github.com/two/repo.git",
      defaultBranch: "main",
      branch: "main",
    });
    await act(async () => old.resolve(disconnected));
    await env.settle();
    assert.match(
      env.document.querySelector("[role=status]")!.textContent!,
      /@two/,
    );
    assert.equal(signals, 0);
    assert.equal(currentCodeRepositories().length, 1);
    assert.equal(
      [...env.document.querySelectorAll("button")].find(
        (e) => e.textContent === "Disconnect",
      )?.disabled,
      false,
    );
  } finally {
    chooseCodeRepository(undefined);
    await env.dispose();
  }
});

test("a lazy Settings navigation retains the explicit connector after the web router normalizes its query", async () => {
  const env = await page({});
  const oldCustomEvent = Object.getOwnPropertyDescriptor(
    globalThis,
    "CustomEvent",
  );
  const oldHistory = Object.getOwnPropertyDescriptor(env.window, "history");
  try {
    Object.defineProperty(globalThis, "CustomEvent", {
      configurable: true,
      writable: true,
      value: env.window.CustomEvent,
    });
    Object.defineProperty(env.window, "history", {
      configurable: true,
      value: {
        replaceState(_state: unknown, _title: string, url: string) {
          env.window.location.href = url;
        },
      },
    });
    const { openSettingsLink, takeSettingsConnectorTarget } =
      await import("../../src/settings/navigation");
    openSettingsLink("connectors", "integration-github");
    env.window.location.href =
      "https://fixture.invalid/code#settings/connectors";
    assert.equal(takeSettingsConnectorTarget(), "integration-github");
    assert.equal(takeSettingsConnectorTarget(), undefined);
    openSettingsLink("connectors", "one");
    openSettingsLink("connectors", "two");
    assert.equal(takeSettingsConnectorTarget(), "two");
    openSettingsLink("connectors", "one");
    openSettingsLink("capabilities");
    assert.equal(takeSettingsConnectorTarget(), undefined);
  } finally {
    if (oldCustomEvent)
      Object.defineProperty(globalThis, "CustomEvent", oldCustomEvent);
    else Reflect.deleteProperty(globalThis, "CustomEvent");
    if (oldHistory) Object.defineProperty(env.window, "history", oldHistory);
    else Reflect.deleteProperty(env.window, "history");
    await env.dispose();
  }
});

test(
  "the actual lazy Connectors tab keeps the requested detail across StrictMode's double state initialization",
  { timeout: 5000 },
  async () => {
    const { createFixtureDesktop, fixtureSettings } =
      await import("../../scripts/preview/app-fixture");
    const { ConnectorsTab } =
      await import("../../src/settings/tabs/Connectors");
    const { openSettingsLink, takeSettingsConnectorTarget } =
      await import("../../src/settings/navigation");
    const bridge = createFixtureDesktop(
      {},
      new URLSearchParams("github=repos&fonts=system&connectors=1"),
    );
    const read = deferred<void>();
    const githubStatus = bridge.githubStatus.bind(bridge);
    bridge.githubStatus = async () => {
      const result = await githubStatus();
      read.resolve();
      return result;
    };
    const env = await page(bridge);
    const oldCustomEvent = Object.getOwnPropertyDescriptor(
      globalThis,
      "CustomEvent",
    );
    const oldHistory = Object.getOwnPropertyDescriptor(env.window, "history");
    try {
      Object.defineProperty(globalThis, "CustomEvent", {
        configurable: true,
        writable: true,
        value: env.window.CustomEvent,
      });
      Object.defineProperty(env.window, "history", {
        configurable: true,
        value: {
          replaceState(_s: unknown, _t: string, url: string) {
            env.window.location.href = url;
          },
        },
      });
      openSettingsLink("connectors", "integration-github");
      env.window.location.href =
        "https://fixture.invalid/code#settings/connectors";
      await env.render(
        "one",
        createElement(
          StrictMode,
          null,
          createElement(ConnectorsTab, {
            settings: fixtureSettings(),
            onError: () => {},
            goTo: () => {},
            save: async () => true,
          }),
        ),
      );
      await act(async () => {
        await read.promise;
      });
      assert.equal(
        env.document.querySelector(".github-connection-page h2")?.textContent,
        "GitHub Integration",
      );
      assert.match(
        env.document.querySelector(".github-connection-account")?.textContent ??
          "",
        /account connected/,
      );
      assert.equal(takeSettingsConnectorTarget(), undefined);
    } finally {
      if (oldCustomEvent)
        Object.defineProperty(globalThis, "CustomEvent", oldCustomEvent);
      else Reflect.deleteProperty(globalThis, "CustomEvent");
      if (oldHistory) Object.defineProperty(env.window, "history", oldHistory);
      else Reflect.deleteProperty(env.window, "history");
      takeSettingsConnectorTarget();
      await env.dispose();
    }
  },
);
