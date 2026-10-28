import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import {
  bundledUi,
  chooseUi,
  compareUiVersions,
  parseUiManifest,
  safePackPath,
  uiVersionFor,
} from "../../shared/ui-pack";
import { parseRelease } from "../../shared/claudex-contract";
import { UiPackStore } from "../../electron/ui-pack/store";
import { verifyPack } from "../../electron/ui-pack/verify";
import { buildUiPack } from "../../scripts/release/ui-pack-lib";

const keys = crypto.generateKeyPairSync("ed25519");
const publicKey = keys.publicKey
  .export({ type: "spki", format: "der" })
  .toString("base64");
const privateKey = keys.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

function dist(files: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-ui-dist-"));
  const all = {
    "index.html": "<div id=root></div>",
    "assets/index.js": "console.log(1)",
    "assets/index.js.map": "{}",
    ...files,
  };
  for (const [name, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

test("interface versions follow the app's and the newer installer wins", () => {
  assert.equal(uiVersionFor("0.0.27"), "0.27.0");
  assert.equal(uiVersionFor("0.0.27", 3), "0.27.3");
  assert.equal(uiVersionFor("1.2.3", 1), "1002.3.1");
  assert.ok(
    compareUiVersions(uiVersionFor("0.0.28"), uiVersionFor("0.0.27", 9)) > 0,
  );
  assert.ok(compareUiVersions("0.27.10", "0.27.9") > 0);
});

test("the offered pack is chosen only when this shell can run it", () => {
  const base = {
    bundled: { version: "0.27.0" },
    bridge: 3,
    bad: [] as string[],
  };
  assert.equal(
    chooseUi({ ...base, offered: { version: "0.27.2", bridge: 3 } }),
    "0.27.2",
  );
  assert.equal(
    chooseUi({ ...base, offered: { version: "0.27.2", bridge: 4 } }),
    bundledUi,
    "needs a newer shell",
  );
  assert.equal(
    chooseUi({ ...base, offered: { version: "0.26.5", bridge: 1 } }),
    bundledUi,
    "older than the installer",
  );
  assert.equal(chooseUi({ ...base, offered: null }), bundledUi, "withdrawn");
  assert.equal(
    chooseUi({
      ...base,
      bad: ["0.27.2"],
      offered: { version: "0.27.2", bridge: 1 },
    }),
    bundledUi,
  );
});

test("pack paths stay inside the pack", () => {
  for (const bad of [
    "../x",
    "/etc/passwd",
    "a/../b",
    "a\\b",
    "",
    "a//b",
    "./a",
  ])
    assert.equal(safePackPath(bad), false, bad);
  assert.ok(safePackPath("assets/index-abc.js"));
  assert.throws(() =>
    parseUiManifest(
      '{"format":1,"version":"0.27.1","bridge":1,"files":{"../x":"' +
        "a".repeat(64) +
        '"}}',
    ),
  );
});

test("a signed pack verifies; tampering or another key does not", async () => {
  const { zip, manifest } = await buildUiPack({
    dist: dist(),
    version: "0.27.1",
    bridge: 1,
    privateKey,
  });
  assert.deepEqual(
    Object.keys(manifest.files).sort(),
    ["assets/index.js", "index.html"],
    "maps are left out",
  );
  const pack = await verifyPack(zip, { publicKey, expectVersion: "0.27.1" });
  assert.equal(pack.files.get("index.html")?.toString(), "<div id=root></div>");

  await assert.rejects(
    verifyPack(zip, { expectVersion: "0.27.1" }),
    /signature/,
    "the release key did not sign it",
  );
  await assert.rejects(
    verifyPack(zip, { publicKey, expectVersion: "0.27.2" }),
    /not 0\.27\.2/,
  );

  const altered = await JSZip.loadAsync(zip);
  altered.file("files/assets/index.js", "steal()");
  await assert.rejects(
    verifyPack(await altered.generateAsync({ type: "nodebuffer" }), {
      publicKey,
    }),
    /does not match/,
  );
  const extra = await JSZip.loadAsync(zip);
  extra.file("files/evil.js", "x");
  await assert.rejects(
    verifyPack(await extra.generateAsync({ type: "nodebuffer" }), {
      publicKey,
    }),
    /unlisted/,
  );
  const unsigned = await JSZip.loadAsync(zip);
  unsigned.remove("manifest.sig");
  await assert.rejects(
    verifyPack(await unsigned.generateAsync({ type: "nodebuffer" }), {
      publicKey,
    }),
    /not signed/,
  );
});

test("the store installs, switches, falls back and prunes", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-ui-store-"));
  const bundledDir = dist();
  const open = () =>
    new UiPackStore(userData, {
      bundledVersion: "0.27.0",
      bridge: 2,
      bundledDir,
    });
  let store = open();
  assert.equal(store.activate(), bundledUi);
  assert.equal(store.rootFor(bundledUi), bundledDir);

  // Offered and not on disk: download it; installed: it becomes the target.
  assert.equal(store.offer({ version: "0.27.1", bridge: 2 }), "0.27.1");
  const { zip } = await buildUiPack({
    dist: dist({ "index.html": "v1" }),
    version: "0.27.1",
    bridge: 2,
    privateKey,
  });
  store.install(await verifyPack(zip, { publicKey }));
  store.installed("0.27.1");
  assert.equal(store.pending, true);
  assert.equal(
    store.current(),
    bundledUi,
    "open windows keep theirs until a switch",
  );
  assert.equal(
    store.pageVersion(),
    "0.27.1",
    "the next page load activates a verified pack without waiting for idle",
  );
  assert.equal(store.pending, false);
  assert.equal(
    store.pageVersion(),
    "0.27.1",
    "ordinary page loads keep the active pack",
  );
  assert.equal(
    fs.readFileSync(path.join(store.rootFor("0.27.1")!, "index.html"), "utf8"),
    "v1",
  );

  // Survives a restart; unreachable service changes nothing.
  store = open();
  assert.equal(store.current(), "0.27.1");
  assert.equal(store.offer(undefined), undefined);
  assert.equal(store.target, "0.27.1");

  // A failed start goes back to the bundled interface; twice and it is bad.
  assert.equal(store.failed("0.27.1"), bundledUi);
  assert.equal(store.current(), bundledUi);
  store.offer({ version: "0.27.1", bridge: 2 });
  assert.equal(store.activate(), "0.27.1", "one failure is retried");
  store.failed("0.27.1");
  assert.deepEqual(store.bad, ["0.27.1"]);
  store.offer({ version: "0.27.1", bridge: 2 });
  assert.equal(store.activate(), bundledUi);

  // Withdrawn: the service offers nothing; unused packs go at the next launch.
  store.offer(null);
  store.activate();
  store.prune();
  assert.equal(fs.existsSync(path.join(store.dir, "0.27.1")), false);
});

test("the release answer carries the pack only when it is complete", () => {
  const base = {
    api_version: 1,
    server: { version: "0.2.8", build_type: "release" },
    channel: "stable",
    latest_version: "0.0.27",
    minimum_version: null,
    state: "current",
    enforced: false,
    download_url: null,
    sha256: null,
    release_notes_url: null,
    release_notes_md: null,
    published_at: null,
  };
  const sha = "a".repeat(64);
  assert.deepEqual(
    parseRelease({
      ...base,
      ui: {
        version: "0.27.1",
        bridge: 1,
        url: "https://claudex.example.com/downloads/claudex/ui/0.27.1/claudex-ui-0.27.1.zip",
        sha256: sha,
      },
    }).ui,
    {
      version: "0.27.1",
      bridge: 1,
      url: "https://claudex.example.com/downloads/claudex/ui/0.27.1/claudex-ui-0.27.1.zip",
      sha256: sha,
    },
  );
  assert.equal(
    parseRelease({
      ...base,
      ui: {
        version: "0.27.1",
        bridge: 1,
        url: "http://x.example/ui.zip",
        sha256: sha,
      },
    }).ui,
    null,
  );
  assert.equal(parseRelease({ ...base, ui: null }).ui, null);
  assert.equal(parseRelease(base).ui, null, "an older service sends no ui");
});
