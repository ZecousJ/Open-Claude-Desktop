/**
 * Several repositories per cloud Code session: a pill per repository with its
 * branch, a × once there are two, and the Add trigger; the choice is what the
 * next session sends and outlives the visit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => store.set(key, value),
  removeItem: (key: string) => store.delete(key),
};

const repos = await import("../../src/composer/code-repository");
const { CloudWorkspaceBar, addRepositoryLabel } =
  await import("../../src/composer/CloudWorkspaceBar");
const { lastRepositoryReason } =
  await import("../../src/composer/RepositoryMenu");

const app = {
  fullName: "acme/app",
  url: "https://github.com/acme/app.git",
  defaultBranch: "main",
  branch: "main",
};
const lib = {
  fullName: "acme/lib",
  url: "https://github.com/acme/lib.git",
  defaultBranch: "trunk",
  branch: "trunk",
};
const tool = {
  fullName: "octo/tool",
  url: "https://github.com/octo/tool.git",
  defaultBranch: "main",
  branch: "main",
};

test("pills are added, swapped, re-branched and removed; the send takes them all", () => {
  repos.chooseCodeRepository(app);
  repos.addCodeRepository(lib);
  repos.addCodeRepository({ ...lib, branch: "other" });
  assert.deepEqual(
    repos.chosenCodeRepositories().map((r) => r.fullName),
    ["acme/app", "acme/lib"],
  );
  repos.setCodeRepositoryBranch("acme/lib", "feature/y");
  assert.deepEqual(repos.currentCodeRepositories(), [
    { url: app.url },
    { url: lib.url, ref: "feature/y" },
  ]);
  // The main repository is what one-repository callers read.
  assert.deepEqual(repos.currentCodeRepository(), { url: app.url });
  // Swapping to one that is already a pill moves it instead of doubling it.
  repos.swapCodeRepository("acme/app", tool);
  assert.deepEqual(
    repos.chosenCodeRepositories().map((r) => r.fullName),
    ["octo/tool", "acme/lib"],
  );
  repos.swapCodeRepository("octo/tool", lib);
  assert.deepEqual(
    repos.chosenCodeRepositories().map((r) => r.fullName),
    ["acme/lib"],
  );
  repos.addCodeRepository(app);
  repos.removeCodeRepository("acme/lib");
  assert.deepEqual(repos.currentCodeRepositories(), [{ url: app.url }]);
  repos.chooseCodeRepository(undefined);
  assert.deepEqual(repos.currentCodeRepositories(), []);
  assert.equal(store.size, 0);
});

test("the list comes back on the next visit, and an older visit's one repository too", () => {
  repos.chooseCodeRepository(app);
  repos.addCodeRepository(lib);
  repos.setCodeRepository(undefined);
  assert.deepEqual(repos.currentCodeRepositories(), []);
  repos.restoreCodeRepository();
  assert.deepEqual(
    repos.chosenCodeRepositories().map((r) => r.fullName),
    ["acme/app", "acme/lib"],
  );
  // One repository kept under the old key before sessions took several.
  repos.chooseCodeRepository(undefined);
  store.set(
    "claudex.code.repository",
    JSON.stringify({ ...app, branch: "dev" }),
  );
  repos.setCodeRepository(undefined);
  repos.restoreCodeRepository();
  assert.deepEqual(repos.currentCodeRepositories(), [
    { url: app.url, ref: "dev" },
  ]);
  assert.deepEqual(
    repos.parseChosenRepositories([app, { ...app }, { fullName: "x" }, lib]),
    [app, lib],
  );
  repos.chooseCodeRepository(undefined);
});

const bar = () => renderToStaticMarkup(createElement(CloudWorkspaceBar));

test("the bar shows a pill per repository and the Add trigger", () => {
  repos.chooseCodeRepository(undefined);
  const empty = bar();
  assert.match(empty, /<span>Repo<\/span>/);
  assert.doesNotMatch(empty, /Remove /);

  repos.chooseCodeRepository(app);
  const one = bar();
  assert.doesNotMatch(one, /<span>Repo<\/span>/);
  // The pill shows the name, the owner is in its tooltip; no × for the last.
  assert.match(one, />app</);
  assert.match(one, /title="acme\/app"/);
  assert.match(one, />main</);
  assert.doesNotMatch(one, /Remove app/);
  assert.match(one, new RegExp(`aria-label="${addRepositoryLabel}"`));

  repos.addCodeRepository(lib);
  const two = bar();
  assert.match(two, /aria-label="Remove app"/);
  assert.match(two, /aria-label="Remove lib"/);
  assert.match(two, />trunk</);
  assert.equal(
    lastRepositoryReason,
    "This session needs at least one repository.",
  );

  // At the runner's limit there is nothing more to add.
  for (let n = 0; n < repos.maxCodeRepositories; n++)
    repos.addCodeRepository({
      ...lib,
      fullName: `acme/r${n}`,
      url: `https://github.com/acme/r${n}.git`,
    });
  assert.equal(
    repos.chosenCodeRepositories().length,
    repos.maxCodeRepositories,
  );
  assert.doesNotMatch(bar(), new RegExp(`aria-label="${addRepositoryLabel}"`));
  repos.chooseCodeRepository(undefined);
});
