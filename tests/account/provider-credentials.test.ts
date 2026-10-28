import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { build } from "esbuild";
import {
  ProviderCredentials,
  type StorageCipher,
} from "../../electron/engine/provider-credentials";
import type { Provider } from "../../shared/types";

test("legacy client key migrates once to backend vault and service uses it after restart", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-credential-migration-"),
  );
  const script = path.join(root, "provider-service.cjs");
  await build({
    entryPoints: ["server/provider-service.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: script,
  });
  const wrappingKey = randomBytes(32);
  const cipher: StorageCipher = {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12),
        aes = createCipheriv("aes-256-gcm", wrappingKey, iv);
      return Buffer.concat([
        iv,
        aes.update(value, "utf8"),
        aes.final(),
        aes.getAuthTag(),
      ]);
    },
    decryptString(data) {
      const iv = data.subarray(0, 12),
        tag = data.subarray(data.length - 16),
        aes = createDecipheriv("aes-256-gcm", wrappingKey, iv);
      aes.setAuthTag(tag);
      return Buffer.concat([
        aes.update(data.subarray(12, -16)),
        aes.final(),
      ]).toString("utf8");
    },
  };
  let upstreamKey = "";
  const upstream = http.createServer((request, response) => {
    upstreamKey = String(request.headers.authorization ?? "");
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const port = (upstream.address() as { port: number }).port;
  const provider: Provider = {
    id: "fixture",
    name: "Fixture",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    protocol: "responses",
    model: "fixture-model",
    models: [],
  };
  try {
    fs.writeFileSync(
      path.join(root, "secrets.enc"),
      cipher.encryptString(
        JSON.stringify({ fixture: "synthetic-legacy-secret" }),
      ),
    );
    const first = new ProviderCredentials(root, script, cipher);
    await first.initialize([provider]);
    assert.equal(first.has("fixture"), true);
    assert.equal(fs.existsSync(path.join(root, "secrets.enc")), false);
    assert.equal(
      (await first.testProvider(provider)).models[0],
      "fixture-model",
    );
    assert.equal(upstreamKey, "Bearer synthetic-legacy-secret");
    first.clear();
    const second = new ProviderCredentials(root, script, cipher);
    await second.initialize([provider]);
    assert.equal(second.has("fixture"), true);
    const vaultFile = fs.readFileSync(
      path.join(root, "backend", "provider-keys.enc"),
      "utf8",
    );
    assert.doesNotMatch(vaultFile, /synthetic-legacy-secret/);
    const masterFile = fs.readFileSync(
      path.join(root, "provider-master.enc"),
      "utf8",
    );
    assert.doesNotMatch(masterFile, /synthetic-legacy-secret/);
    await second.setKeys({ fixture: "" }, [provider]);
    assert.equal(second.has("fixture"), false);
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
