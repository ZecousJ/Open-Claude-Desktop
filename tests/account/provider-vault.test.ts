import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ProviderVault } from "../../server/provider-vault";

test("provider vault keeps dynamic keys out of plaintext storage and isolates accounts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-vault-")),
    other = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-vault-"));
  const master = randomBytes(32).toString("hex");
  try {
    const vault = new ProviderVault(root, master);
    assert.deepEqual(
      vault.setMany(
        { first: "synthetic-secret-one", second: "synthetic-secret-two" },
        ["first", "second"],
      ),
      { first: true, second: true },
    );
    const filename = path.join(root, "backend", "provider-keys.enc");
    const disk = fs.readFileSync(filename, "utf8");
    assert.doesNotMatch(disk, /synthetic-secret-one|synthetic-secret-two/);
    const restored = new ProviderVault(root, master);
    assert.equal(restored.get("first"), "synthetic-secret-one");
    restored.setMany({ first: "" }, ["first"]);
    assert.deepEqual(restored.status(["first", "second"]), {
      first: false,
      second: false,
    });
    assert.equal(new ProviderVault(other, master).get("first"), "");
    assert.throws(
      () => new ProviderVault(root, randomBytes(32).toString("hex")),
      /cannot be decrypted/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});
