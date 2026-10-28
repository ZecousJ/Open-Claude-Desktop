import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import { FeedArchitecture } from "../../electron/updates/feed-architecture";
import {
  desktopModelUpdateRequired,
  catalogChoices,
  codeModelChoices,
} from "../../src/composer/model/code-model-choices";
import { parseModelCatalog } from "../../shared/claudex-contract";
import {
  macApplyScript,
  macRelaunchScript,
  windowsApplyScript,
} from "../../electron/updates/scripts";
import { claudexArtifacts } from "../../scripts/release/release-lib";

test("native feeds probe architecture, cache 200/404 for 24 hours, and reset after errors", async () => {
  let now = 0;
  let status = 404;
  let calls = 0;
  const probe = new FeedArchitecture(
    async () => {
      calls++;
      return status;
    },
    () => now,
  );
  const base =
    "https://updates.example/api/desktop/darwin/universal/squirrel/update?device_id=a";
  assert.match(await probe.select(base, "arm64"), /darwin\/arm64\//);
  status = 500;
  assert.match(await probe.select(base, "arm64"), /darwin\/arm64\//);
  assert.equal(calls, 1);
  now = 24 * 60 * 60_000;
  assert.equal(await probe.select(base, "arm64"), base);
  assert.equal(calls, 2);
  status = 200;
  probe.clear();
  assert.match(await probe.select(base, "x64"), /darwin\/x64\//);
  probe.clear();
  status = 0;
  assert.equal(await probe.select(base, "x64"), base);
  assert.equal(
    await probe.select("https://updates.example/custom", "arm64"),
    "https://updates.example/custom",
  );
});

test("desktop version gates fail closed for invalid versions and do not gate the web runner", () => {
  assert.equal(desktopModelUpdateRequired("1.0.0", "1.0.1"), true);
  assert.equal(desktopModelUpdateRequired("1.0.1", "1.0.1"), false);
  assert.equal(desktopModelUpdateRequired("1.0.2", "1.0.1"), false);
  assert.equal(
    desktopModelUpdateRequired("1.0.2-beta.1+build.2", "1.0.1"),
    false,
  );
  assert.equal(desktopModelUpdateRequired("invalid", "1.0.1"), true);
  assert.equal(desktopModelUpdateRequired("1.0.1", "invalid"), true);
  assert.equal(desktopModelUpdateRequired(undefined, "1.0.1"), false);
  const catalog = parseModelCatalog({
    default_model: "gpt-test",
    items: [
      {
        id: "gpt-test",
        display_name: "Test",
        description: "",
        badges: [],
        sort: 0,
        hidden: false,
        default: true,
        usage_hint: "",
        minimum_desktop_version: "1.0.1",
      },
    ],
  });
  assert.equal(catalog.items[0].minimumDesktopVersion, "1.0.1");
  const providers = [
    {
      id: "p",
      name: "P",
      protocol: "responses" as const,
      baseUrl: "https://example.com",
      model: "gpt-test",
      models: ["gpt-test"],
    },
  ];
  assert.equal(
    catalogChoices(providers, { ...catalog, desktopVersion: "1.0.0" }).listed[0]
      .updateRequired,
    true,
  );
  assert.equal(
    catalogChoices(providers, catalog).listed[0].updateRequired,
    false,
  );
  assert.equal(
    codeModelChoices(providers, "p", "gpt-test", {
      ...catalog,
      desktopVersion: "1.0.0",
    }).quick[0].updateRequired,
    false,
  );
  assert.equal(
    codeModelChoices(providers, "p", "other", {
      ...catalog,
      desktopVersion: "1.0.0",
    }).quick[0].updateRequired,
    true,
  );
});

test("the network page lazily lists the configured updater's endpoints and purposes", () => {
  const page = fs.readFileSync("src/settings/tabs/Network.tsx", "utf8");
  assert.match(page, /environment.updateEndpoints/);
  assert.match(page, /t\(endpoint.purpose\)/);
  assert.doesNotMatch(page, /api\.anthropic\.com|releases\.claude\.com/);
  assert.match(
    fs.readFileSync("src/settings/SettingsDialog.tsx", "utf8"),
    /lazyPiece\(\(\) => import\("\.\/tabs\/Network"\)/,
  );
});
