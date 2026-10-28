import test from "node:test";
import assert from "node:assert/strict";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { desktopHost, webHost, type HostInfo } from "../../shared/host";
import type { Mode } from "../../shared/types";
import { HostContext } from "../../src/host/HostContext";
import { ChatHome } from "../../src/home/ChatHome";
import { coworkAvailable, homeMode } from "../../src/home/home-mode";

const withCapabilities = (
  host: HostInfo,
  capabilities: Partial<HostInfo["capabilities"]>,
): HostInfo => ({
  kind: host.kind,
  capabilities: { ...host.capabilities, ...capabilities },
});
const cloudCoworkWeb = withCapabilities(webHost, { cloudCowork: true });
const cloudCodeWeb = withCapabilities(webHost, { cloudCode: true });

const render = (host: HostInfo, node: ReactNode) =>
  renderToStaticMarkup(
    createElement(HostContext.Provider, { value: host }, node),
  );

const home = (host: HostInfo, mode: Mode, incognito = false) =>
  render(
    host,
    createElement(ChatHome, {
      name: "Ada",
      mode,
      model: "gpt",
      connectionDismissed: true,
      incognito,
      onServiceStatus: () => {},
      onDismiss: () => {},
      onSuggestion: () => {},
      composer: createElement("div", { className: "composer-probe" }),
    }),
  );

test("Cowork is available on the desktop, and on the web only with cloud Cowork", () => {
  assert.equal(coworkAvailable(desktopHost), true);
  assert.equal(coworkAvailable(webHost), false);
  assert.equal(coworkAvailable(cloudCoworkWeb), true);
  // Cloud Code alone does not bring Cowork.
  assert.equal(coworkAvailable(cloudCodeWeb), false);
});

test("legacy task modes retain the unified greeting and composer on every host", async () => {
  // The ideas load with their own chunk: the first render starts the load,
  // and once it is in they render with the home.
  home(desktopHost, "cowork");
  await import("../../src/cowork/CoworkIdeas");
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(
    home(desktopHost, "cowork"),
    /Ideas for you|Send me a daily briefing/,
  );
  assert.match(home(desktopHost, "cowork"), /class="composer-probe"/);
  // They all act on a folder on this computer, which the web has not got,
  // even once cloud Cowork is on (its home shows the Active list instead).
  assert.doesNotMatch(home(webHost, "cowork"), /Ideas for you/);
  assert.doesNotMatch(home(cloudCoworkWeb, "cowork"), /Ideas for you/);
  assert.doesNotMatch(home(desktopHost, "chat"), /Ideas for you/);
});

test("the web Chat home keeps the greeting, composer and incognito note", () => {
  const html = home(webHost, "chat");
  assert.match(html, /<h1><svg[^>]*class="star"/);
  assert.match(html, /class="composer-probe"/);
  const incognito = home(webHost, "chat", true);
  assert.match(incognito, /You’re incognito/);
  assert.match(incognito, /Incognito sessions stay out of your history/);
  assert.match(incognito, /incognito-learn-more/);
  assert.match(incognito, /class="composer-probe"/);
});

test("Chat and Cowork are one home: a task home where Cowork runs, else Chat; Code always shows", () => {
  for (const mode of ["chat", "cowork"] as const) {
    assert.equal(homeMode(mode, desktopHost), "cowork");
    assert.equal(homeMode(mode, webHost), "chat");
    assert.equal(homeMode(mode, cloudCoworkWeb), "cowork");
    assert.equal(homeMode(mode, cloudCodeWeb), "chat");
    // An incognito chat stays a chat.
    assert.equal(homeMode(mode, desktopHost, true), "chat");
  }
  // claude.ai/code shows its page before a cloud environment runs.
  for (const host of [desktopHost, webHost, cloudCoworkWeb, cloudCodeWeb])
    assert.equal(homeMode("code", host), "code");
});
