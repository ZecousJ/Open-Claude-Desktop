import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { build } from "esbuild";
import { loadOperatorConfig } from "../../server/operator-config";
import {
  ProviderCredentials,
  type StorageCipher,
} from "../../electron/engine/provider-credentials";

test("operator config bootstraps a server-only key; desktop account can use the model immediately", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-operator-"));
  const script = path.join(root, "provider-service.cjs");
  await build({
    entryPoints: ["server/provider-service.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: script,
  });
  let authorization = "";
  const upstream = http.createServer((request, response) => {
    authorization = String(request.headers.authorization ?? "");
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const port = (upstream.address() as { port: number }).port;
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
      const aes = createDecipheriv(
        "aes-256-gcm",
        wrappingKey,
        data.subarray(0, 12),
      );
      aes.setAuthTag(data.subarray(-16));
      return Buffer.concat([
        aes.update(data.subarray(12, -16)),
        aes.final(),
      ]).toString("utf8");
    },
  };
  try {
    const key = "synthetic-operator-secret";
    const configured = spawnSync(
      process.execPath,
      [
        "scripts/configure-backend.mjs",
        "--data-dir",
        root,
        "--base-url",
        `http://127.0.0.1:${port}/v1`,
        "--model",
        "fixture-model",
        "--transcription-model",
        "fixture-transcribe",
        "--protocol",
        "responses",
        "--key-stdin",
      ],
      { input: key, encoding: "utf8" },
    );
    assert.equal(configured.status, 0, configured.stderr);
    assert.equal(configured.stdout.includes(key), false);
    const config = loadOperatorConfig(root)!;
    assert.equal(config.providers[0].model, "fixture-model");
    assert.equal(config.providers[0].transcriptionModel, "fixture-transcribe");
    const configFile = path.join(root, "backend", "operator.json");
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        ...config,
        providers: [
          {
            ...config.providers[0],
            apiKey: "fixture-should-never-reach-renderer",
          },
        ],
      }),
    );
    assert.equal("apiKey" in loadOperatorConfig(root)!.providers[0], false);
    const unavailable: StorageCipher = {
      isEncryptionAvailable: () => false,
      encryptString() {
        throw Error("Unavailable");
      },
      decryptString() {
        throw Error("Unavailable");
      },
    };
    await assert.rejects(
      new ProviderCredentials(root, script, unavailable).initialize(
        config.providers,
      ),
      /OS encrypted storage/,
    );
    assert.equal(
      fs.existsSync(path.join(root, "backend", "bootstrap-secret.json")),
      true,
    );
    const credentials = new ProviderCredentials(root, script, cipher);
    await credentials.initialize(config.providers);
    assert.equal(credentials.has(config.activeProviderId), true);
    assert.equal(
      fs.existsSync(path.join(root, "backend", "bootstrap-secret.json")),
      false,
    );
    const result = await credentials.testProvider(config.providers[0]);
    assert.deepEqual(result.models, ["fixture-model"]);
    assert.equal(authorization, `Bearer ${key}`);
    assert.equal(
      fs
        .readFileSync(path.join(root, "backend", "provider-keys.enc"), "utf8")
        .includes(key),
      false,
    );
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
