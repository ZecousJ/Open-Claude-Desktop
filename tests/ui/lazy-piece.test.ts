/**
 * Each lazily loaded piece shows its own load failure in its place: one quiet
 * retry of its own, then "Couldn’t load this." with Retry, then Reload;
 * "Claudex was updated." when a newer build removed its script; "You’re
 * offline." while the network is gone; anything that is not a load failure goes
 * to the nearest boundary.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement, Suspense } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createPieceStore,
  errorStateOf,
  type RecoveryEnv,
} from "../../src/app/chunk-recovery";
import type { AssetVerdict } from "../../src/app/chunk-status";
import {
  failedAssetUrl,
  failedScriptUrl,
  isStylesheetFailure,
} from "../../src/app/chunk-status";
import { ChunkErrorView, lazyPiece } from "../../src/ui/lazy-piece";

const chunkError = (file = "https://app.test/assets/Thing-abc.js") =>
  new TypeError(`Failed to fetch dynamically imported module: ${file}`);

function fakeEnv(overrides: Partial<RecoveryEnv> = {}) {
  let clock = 0;
  let online = true;
  const timers: { at: number; run: () => void; id: number }[] = [];
  let nextId = 1;
  const onlineWaiters = new Set<() => void>();
  const imported: string[] = [];
  let reloads = 0;
  let verdict: AssetVerdict = "unknown";
  const env: RecoveryEnv = {
    online: () => online,
    hidden: () => false,
    now: () => clock,
    setTimeout(run, ms) {
      const id = nextId++;
      timers.push({ at: clock + ms, run, id });
      return id;
    },
    clearTimeout(id) {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
    whenOnline(run) {
      onlineWaiters.add(run);
      return () => onlineWaiters.delete(run);
    },
    whenVisible: () => () => undefined,
    lastResume: () => Number.NEGATIVE_INFINITY,
    importUrl: async (url) => {
      imported.push(url);
      throw chunkError(url);
    },
    verdict: async () => verdict,
    reload: () => {
      reloads += 1;
    },
    ...overrides,
  };
  return {
    env,
    imported,
    reloads: () => reloads,
    setVerdict(next: AssetVerdict) {
      verdict = next;
    },
    goOffline() {
      online = false;
    },
    goOnline() {
      online = true;
      for (const run of [...onlineWaiters]) {
        onlineWaiters.delete(run);
        run();
      }
    },
    /** Moves the clock, running due timers and letting promises settle. */
    async advance(ms: number) {
      const until = clock + ms;
      await flush();
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > until) break;
        timers.shift();
        clock = next.at;
        next.run();
        await flush();
      }
      clock = until;
      await flush();
    },
  };
}

async function flush() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

const Thing = () => createElement("p", null, "thing");

test("a piece that loads is the loaded component", async () => {
  const { env } = fakeEnv();
  const store = createPieceStore(
    async () => ({ default: Thing }),
    (m) => (m as { default: typeof Thing }).default,
    env,
  );
  store.start();
  assert.equal(store.snapshot().phase, "loading");
  await flush();
  assert.equal(store.snapshot().phase, "loaded");
  assert.equal(store.loaded(), Thing);
});

test("a failed load retries once quietly, then offers Retry, then Reload", async () => {
  const fake = fakeEnv();
  let calls = 0;
  const store = createPieceStore(
    async () => {
      calls += 1;
      throw chunkError();
    },
    () => Thing,
    fake.env,
  );
  store.start();
  await fake.advance(0);
  // Quiet: the caller's loading state stays while it retries on its own.
  assert.equal(store.snapshot().phase, "auto_retry");
  await fake.advance(400);
  assert.equal(calls, 2);
  // The browser remembered the failure: the same file, freshly addressed.
  assert.deepEqual(fake.imported, [
    "https://app.test/assets/Thing-abc.js?cb=r1",
  ]);
  assert.equal(errorStateOf(store.snapshot()), "retry");
  store.retry();
  assert.equal(store.snapshot().phase, "retrying");
  await fake.advance(0);
  assert.equal(calls, 3);
  assert.equal(errorStateOf(store.snapshot()), "reload");
  store.reload();
  assert.equal(store.snapshot().phase, "reloading");
  assert.equal(fake.reloads(), 1);
});

test("a retry that succeeds shows the piece", async () => {
  const fake = fakeEnv();
  let calls = 0;
  const store = createPieceStore(
    async () => {
      calls += 1;
      if (calls === 1) throw chunkError();
      return { default: Thing };
    },
    (m) => (m as { default: typeof Thing }).default,
    fake.env,
  );
  store.start();
  await fake.advance(400);
  assert.equal(store.snapshot().phase, "loaded");
});

test("a script a newer build removed says Claudex was updated", async () => {
  const fake = fakeEnv();
  fake.setVerdict("updated");
  const store = createPieceStore(
    async () => {
      throw chunkError();
    },
    () => Thing,
    fake.env,
  );
  store.start();
  await fake.advance(0);
  assert.equal(errorStateOf(store.snapshot()), "updated");
});

test("a failed import the script needs, or a stylesheet, goes to Reload", async () => {
  const dependency = fakeEnv();
  dependency.setVerdict("dependency");
  const first = createPieceStore(
    async () => {
      throw chunkError();
    },
    () => Thing,
    dependency.env,
  );
  first.start();
  await dependency.advance(0);
  assert.equal(errorStateOf(first.snapshot()), "reload");

  const css = fakeEnv();
  const second = createPieceStore(
    async () => {
      throw new Error(
        "Unable to preload CSS for https://app.test/assets/thing.css",
      );
    },
    () => Thing,
    css.env,
  );
  second.start();
  await css.advance(0);
  assert.equal(errorStateOf(second.snapshot()), "reload");
});

test("a retry still out after 3 s offers Retry while it carries on", async () => {
  const fake = fakeEnv({
    importUrl: () => new Promise(() => undefined),
  });
  let calls = 0;
  const store = createPieceStore(
    async () => {
      calls += 1;
      if (calls === 1) throw chunkError();
      return new Promise(() => undefined);
    },
    () => Thing,
    fake.env,
  );
  store.start();
  await fake.advance(400);
  assert.equal(store.snapshot().phase, "auto_retry");
  await fake.advance(3000);
  assert.equal(errorStateOf(store.snapshot()), "retry");
  // Given up after 3.5 s: still Retry.
  await fake.advance(500);
  assert.equal(errorStateOf(store.snapshot()), "retry");
});

test("offline, it says so after 2 s and retries once the network is back", async () => {
  const fake = fakeEnv();
  let calls = 0;
  const store = createPieceStore(
    async () => {
      calls += 1;
      if (calls === 1) throw chunkError();
      return { default: Thing };
    },
    (m) => (m as { default: typeof Thing }).default,
    fake.env,
  );
  fake.goOffline();
  store.start();
  await fake.advance(0);
  assert.equal(store.snapshot().phase, "auto_retry");
  await fake.advance(2000);
  assert.equal(errorStateOf(store.snapshot()), "waiting");
  fake.goOnline();
  assert.equal(store.snapshot().phase, "auto_retry");
  await fake.advance(3000);
  assert.equal(calls, 2);
  assert.equal(store.snapshot().phase, "loaded");
});

test("Reload pressed offline waits for the network", async () => {
  const fake = fakeEnv();
  fake.setVerdict("dependency");
  const store = createPieceStore(
    async () => {
      throw chunkError();
    },
    () => Thing,
    fake.env,
  );
  store.start();
  await fake.advance(0);
  fake.goOffline();
  store.reload();
  assert.equal(errorStateOf(store.snapshot()), "waiting-reload");
  assert.equal(fake.reloads(), 0);
  fake.goOnline();
  assert.equal(fake.reloads(), 1);
});

test("a failure of the piece's own code is not this piece's to recover", async () => {
  const fake = fakeEnv();
  const broken = new Error("The module threw while evaluating.");
  const store = createPieceStore(
    async () => {
      throw broken;
    },
    () => Thing,
    fake.env,
  );
  store.start();
  await fake.advance(0);
  assert.equal(store.snapshot().phase, "declined");
  assert.equal(store.snapshot().error, broken);
});

test("the failed file is read from the browser's message", () => {
  const url = "http://localhost/assets/Thing-abc.js";
  assert.equal(failedAssetUrl(chunkError(url)), url);
  assert.equal(failedScriptUrl(chunkError(url)), url);
  // Safari names no file.
  assert.equal(
    failedAssetUrl(new TypeError("Importing a module script failed.")),
    undefined,
  );
  const css = new Error("Unable to preload CSS for http://localhost/a.css");
  assert.equal(failedScriptUrl(css), undefined);
  assert.ok(isStylesheetFailure(css));
});

test("the view says each state with its button", () => {
  const html = (state: Parameters<typeof ChunkErrorView>[0]["state"]) =>
    renderToStaticMarkup(
      createElement(ChunkErrorView, {
        state,
        onRetry: () => undefined,
        onReload: () => undefined,
      }),
    );
  assert.match(html("retry"), /Couldn’t load this\.<\/span>.*>Retry</);
  assert.match(html("waiting"), /You’re offline\.<\/span>.*>Retry</);
  assert.match(html("waiting-reload"), /You’re offline\.<\/span>.*>Reload</);
  assert.match(
    html("updated"),
    /Claudex was updated\. Reload to continue\.<\/span>.*>Reload</,
  );
  assert.match(
    html("reload"),
    /Couldn’t load this\. Reload the page to continue\.<\/span>.*>Reload</,
  );
  assert.match(html("retry"), /role="status"/);
  assert.match(html("retry"), /data-chunk-error="retry"/);
});

test("a piece suspends while loading and renders once loaded", async () => {
  const Piece = lazyPiece(async () => ({ Named: Thing }), "Named");
  const tree = () =>
    renderToStaticMarkup(
      createElement(Suspense, { fallback: "loading" }, createElement(Piece)),
    );
  assert.equal(tree(), "loading");
  await flush();
  assert.equal(tree(), "<p>thing</p>");
});
