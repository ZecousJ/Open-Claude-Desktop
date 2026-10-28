import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { locationMetadataExtension } from "../../electron/account/location-metadata";
import {
  EngineExtensions,
  type EngineTurnContext,
} from "../../electron/engine/engine-extensions";
import { defaultSettings, Store } from "../../electron/store/store";
import { normalizeSettings } from "../../runner/src/cloud-store";
import { Sub2ApiClient } from "../../electron/sub2api/client";
import { parseCoarseLocation } from "../../shared/location-metadata";
import { preference } from "../../shared/settings-extras";
import { preferenceFields } from "../../shared/settings-extras-schema";
import { openPolicy } from "../../shared/client-policy";
import { LocationMetadataRow } from "../../src/settings/LocationMetadataRow";
import { isUserOp, parseRunnerFrame } from "../../shared/web-runner-frames";

test("the runner location operation requires an authenticated user identity", () => {
  assert.equal(isUserOp("location.get"), true);
  const frame = { t: "request", id: "loc-1", op: "location.get", body: {} };
  assert.throws(() => parseRunnerFrame(JSON.stringify(frame)), /needs userId/);
  assert.equal(
    parseRunnerFrame(JSON.stringify({ ...frame, userId: 7 })).t,
    "request",
  );
});

const location = {
  city: "Brisbane",
  region: "Queensland",
  country: "Australia",
};

function context(mode: "chat" | "cowork" | "code" = "chat"): EngineTurnContext {
  return {
    conversation: {
      id: "c",
      title: "t",
      mode,
      providerId: "default",
      model: "m",
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      turns: [],
      cwd: "/work",
    },
    mode,
    provider: defaultSettings.providers[0],
    model: "m",
    policy: openPolicy,
    settings: defaultSettings,
    sandbox: "workspace-write",
  };
}

test("location metadata defaults on and survives the preferences patch", () => {
  assert.equal(preference({}, "locationMetadata"), true);
  assert.equal(preferenceFields.locationMetadata.parse(false), false);
  for (const enabled of [undefined, true, false]) {
    const html = renderToStaticMarkup(
      createElement(LocationMetadataRow, {
        settings: { ...defaultSettings, locationMetadata: enabled },
        save() {},
      }),
    );
    assert.match(html, new RegExp(`aria-checked="${enabled !== false}"`));
    assert.doesNotMatch(html, /disabled=""/);
    assert.match(html, /city\/region/);
    assert.match(html, /Learn more/);
  }
});

test("the preference persists across desktop relaunch and web settings normalization", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-location-"));
  try {
    const store = new Store(root);
    assert.equal(preference(store.settings, "locationMetadata"), true);
    store.settings.locationMetadata = false;
    store.flush();
    const restored = new Store(root);
    assert.equal(restored.settings.locationMetadata, false);
    assert.equal(normalizeSettings(restored.settings).locationMetadata, false);
    assert.equal(preference(normalizeSettings(null), "locationMetadata"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("one session lookup supplies every Chat and Cowork turn, never Code or opt-out", async () => {
  const settings = { locationMetadata: false };
  let calls = 0;
  const cached = locationMetadataExtension(
    () => settings,
    async () => {
      calls++;
      return location;
    },
  );
  const registry = new EngineExtensions();
  registry.add(cached.extension);
  await cached.prepare();
  await registry.prepareTurn(context());
  assert.equal(calls, 0);
  assert.equal(registry.turnContext(context()), undefined);
  settings.locationMetadata = true;
  await registry.prepareTurn(context("code"));
  assert.equal(calls, 0);
  await Promise.all([
    registry.prepareTurn(context()),
    registry.prepareTurn(context("cowork")),
    cached.prepare(),
  ]);
  assert.equal(calls, 1);
  for (const mode of ["chat", "cowork"] as const) {
    const ctx = context(mode);
    await registry.prepareTurn(ctx);
    assert.deepEqual(registry.turnContext(ctx), {
      "location.coarse": {
        value: "Approximate user location: Brisbane, Queensland, Australia.",
        kind: "application",
      },
    });
  }
  assert.equal(registry.turnContext(context("code")), undefined);
  settings.locationMetadata = false;
  await registry.prepareTurn(context());
  assert.equal(registry.turnContext(context()), undefined);
  assert.equal(calls, 1);
});

test("opt-out during lookup suppresses context and accounts do not share caches", async () => {
  const settings = { locationMetadata: true };
  let resolve!: (value: unknown) => void;
  const first = locationMetadataExtension(
    () => settings,
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = first.prepare();
  settings.locationMetadata = false;
  resolve(location);
  await pending;
  assert.equal(first.extension.turnContext?.(context()), undefined);
  const second = locationMetadataExtension(
    () => ({ locationMetadata: true }),
    async () => ({ city: "", region: "", country: "" }),
  );
  await second.prepare();
  assert.equal(second.extension.turnContext?.(context()), undefined);
});

test("lookup failures and malformed answers never block a turn or inject context", async () => {
  for (const lookup of [
    async () => {
      throw Error("offline");
    },
    async () => ({ city: "bad\ncontext", region: "", country: "" }),
  ]) {
    const cached = locationMetadataExtension(() => ({}), lookup);
    await cached.prepare();
    assert.equal(cached.extension.turnContext?.(context()), undefined);
  }
  assert.equal(parseCoarseLocation(null), null);
  assert.equal(parseCoarseLocation({ country: "US" }), null);
});

test("desktop location client uses the authenticated service endpoint", async () => {
  const client = new Sub2ApiClient(
    "https://service.test",
    async (input, init) => {
      assert.equal(
        String(input),
        "https://service.test/api/v1/claudex/location",
      );
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer access-token",
      );
      return new Response(JSON.stringify({ code: 0, data: location }), {
        status: 200,
      });
    },
  );
  assert.deepEqual(await client.location("access-token"), location);
});
