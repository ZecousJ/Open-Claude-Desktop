/**
 * The web Code home's repository flow: the chosen repository outlives the home
 * and the reload, the repository menu's empty, connect and expired states use
 * the live picker's words, the environment menu says the network level under
 * each environment, and a return from GitHub without a connection has its own
 * page.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  chooseCodeRepository,
  chosenCodeRepository,
  currentCodeRepository,
  parseChosenRepository,
  restoreCodeRepository,
  setCodeRepository,
} from "../../src/composer/code-repository";
import { networkLabels } from "../../src/composer/CloudWorkspaceBar";
import { RepositoryMenu } from "../../src/composer/RepositoryMenu";
import { githubReturnText } from "../../src/composer/GitHubReturnPrompt";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => store.set(key, value),
  removeItem: (key: string) => store.delete(key),
};

const repo = {
  fullName: "acme/app",
  url: "https://github.com/acme/app.git",
  defaultBranch: "main",
  branch: "main",
};

test("a chosen repository and branch are what the chips show and the send takes", () => {
  chooseCodeRepository(repo);
  assert.deepEqual(chosenCodeRepository(), repo);
  assert.deepEqual(currentCodeRepository(), { url: repo.url });
  chooseCodeRepository({ ...repo, branch: "feature/x" });
  assert.deepEqual(currentCodeRepository(), {
    url: repo.url,
    ref: "feature/x",
  });
  chooseCodeRepository(undefined);
  assert.equal(chosenCodeRepository(), undefined);
  assert.equal(currentCodeRepository(), undefined);
  assert.equal(store.size, 0);
});

test("the choice comes back on the next visit, and only a well-formed one", () => {
  chooseCodeRepository({ ...repo, branch: "dev" });
  // Leaving (the desktop's cloud environment) forgets it in memory only.
  setCodeRepository(undefined);
  assert.equal(currentCodeRepository(), undefined);
  restoreCodeRepository();
  assert.deepEqual(currentCodeRepository(), { url: repo.url, ref: "dev" });
  assert.equal(chosenCodeRepository()?.fullName, "acme/app");
  // Restored once per visit: a later "No repository" stays.
  chooseCodeRepository(undefined);
  restoreCodeRepository();
  assert.equal(currentCodeRepository(), undefined);
  assert.equal(
    parseChosenRepository({ ...repo, url: "http://x/y" }),
    undefined,
  );
  assert.equal(parseChosenRepository({ ...repo, fullName: "app" }), undefined);
  assert.equal(parseChosenRepository("acme/app"), undefined);
  assert.deepEqual(parseChosenRepository({ ...repo, extra: 1 }), repo);
});

const menu = (status: Parameters<typeof RepositoryMenu>[0]["status"]) =>
  renderToStaticMarkup(
    createElement(RepositoryMenu, {
      status,
      left: 0,
      anchor: { current: null },
      onChoose: () => {},
      onStatus: () => {},
      onClose: () => {},
    }),
  );

test("the repository menu says the live picker's words", () => {
  const disconnected = menu({ configured: true, connected: false });
  assert.match(
    disconnected,
    /Connect GitHub to pick a repository for this session/,
  );
  assert.match(disconnected, /Connect to GitHub/);
  const connected = menu({ configured: true, connected: true, login: "o" });
  assert.match(connected, /placeholder="Search repositories…"/);
  assert.match(connected, /Refresh list/);
  assert.match(connected, /Disconnect @o/);
  assert.match(
    menu({ configured: false, connected: false }),
    /isn&#x27;t set up/,
  );
});

test("the environment rows say the sandbox's network level as the live lists do", () => {
  assert.deepEqual(networkLabels, {
    none: "No network access",
    trusted: "Trusted network access",
    custom: "Custom network access",
    full: "Full network access",
  });
});

test("a return from GitHub without a connection says why", () => {
  assert.equal(githubReturnText.title, "GitHub connection not completed");
  assert.match(githubReturnText.denied, /canceled or didn’t go through/);
  assert.match(githubReturnText.failed, /Something went wrong/);
});
