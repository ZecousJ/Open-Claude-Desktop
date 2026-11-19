import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startOfficialUiServer } from "../electron/official-ui/server";

test("public servers return the recovered empty schema without accessing account data", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "official-public-directory-"),
  );
  fs.mkdirSync(path.join(root, "ui"));
  fs.writeFileSync(
    path.join(root, "ui", "index.html"),
    "<!doctype html><title>Test</title>",
  );
  let accountReads = 0;
  const server = await startOfficialUiServer({
    root,
    api: () => {
      accountReads++;
      throw Error("Public directory must not access accounts");
    },
  });
  try {
    for (const query of [
      "",
      "?visibility=claude&verified_tier=anthropic,partner,community&limit=5000",
    ]) {
      const response = await fetch(
        server.origin + "/api/__public/directory/servers" + query,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        servers: [],
        next_cursor: null,
      });
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    const options = await fetch(
      server.origin + "/api/__public/directory/servers",
      { method: "OPTIONS" },
    );
    assert.equal(options.status, 204);
    assert.equal(await options.text(), "");
    const rejected = await fetch(
      server.origin + "/api/__public/directory/servers",
      { method: "POST" },
    );
    assert.equal(rejected.status, 403);
    assert.equal(accountReads, 0);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
