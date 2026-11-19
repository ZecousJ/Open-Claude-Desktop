import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { bootstrapOutputSha256, verifiedBootstrapDefaults, verifyPackagedBootstrap } from "../scripts/official-ui-bootstrap-defaults.mjs";

const root = process.cwd();
const archive = process.env.CLAUDEX_OFFICIAL_ARCHIVE ?? path.join(root, ".restore/handoff-source.tar.gz");
const extracted = process.env.CLAUDEX_OFFICIAL_EXTRACTED ?? path.join(root, ".restore/archive-extracted");
const original = path.join(extracted, "claude-frontend-4.4212.0/recovery/claudex-bootstrap-defaults.json");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("private local captures are ignored and only pinned bootstrap bytes are accepted", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-bootstrap-trust-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(temp, "recovery"));
  fs.mkdirSync(path.join(temp, ".local"));
  fs.copyFileSync(original, path.join(temp, "recovery/claudex-bootstrap-defaults.json"));
  fs.writeFileSync(path.join(temp, ".local/bootstrap-ui.json"), JSON.stringify({ nested: { access_token: "synthetic-private-marker" } }));
  const result = verifiedBootstrapDefaults(temp, archive);
  assert.equal(sha(result), bootstrapOutputSha256);
  assert.equal(result.includes(Buffer.from("synthetic-private-marker")), false);
  fs.appendFileSync(path.join(temp, "recovery/claudex-bootstrap-defaults.json"), " ");
  assert.throws(() => verifiedBootstrapDefaults(temp, archive), /checksum mismatch/);
  const badArchive = path.join(temp, "wrong-archive.tar.gz");
  fs.writeFileSync(badArchive, "not the pinned archive");
  assert.throws(() => verifiedBootstrapDefaults(temp, badArchive), /archive checksum mismatch/);
});

test("packaged bootstrap bytes must remain exact", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-bootstrap-package-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(temp, "data"));
  const bytes = verifiedBootstrapDefaults(path.dirname(path.dirname(original)), archive);
  const file = path.join(temp, "data/bootstrap-defaults.json");
  fs.writeFileSync(file, bytes);
  assert.doesNotThrow(() => verifyPackagedBootstrap(temp));
  fs.appendFileSync(file, " ");
  assert.throws(() => verifyPackagedBootstrap(temp), /checksum mismatch/);
});
