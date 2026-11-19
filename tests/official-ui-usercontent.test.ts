import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { startOfficialUserContentServer } from "../server/official-usercontent";
import {
  configureUserContentDocument,
  createUserContentHandler,
  userContentOrigin,
} from "../electron/official-ui/usercontent";

test("official preview changes only runtime parent configuration and serves pinned isolated assets", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-usercontent-test-"),
  );
  const parent = "http://localhost:5555";
  const config = {
    defaultParentOrigin: "claude.ai",
    allowedParentOrigins: ["https://claude.ai"],
    unchanged: 42,
  };
  const html =
    "<script>self.__next_f.push(" +
    JSON.stringify([1, JSON.stringify(config)]) +
    ")</script><script src='/asset.js'></script>";
  const asset = "console.log('official byte-for-byte asset');";
  try {
    fs.writeFileSync(path.join(root, "index.html"), html);
    fs.writeFileSync(path.join(root, "asset.js"), asset);
    fs.writeFileSync(
      path.join(root, "manifest.json"),
      JSON.stringify({
        assets: [
          ["/", "index.html", html],
          ["/asset.js", "asset.js", asset],
        ].map(([url, file, value]) => ({
          path: url,
          file,
          sha256: createHash("sha256").update(value).digest("hex"),
        })),
      }),
    );
    const handler = createUserContentHandler(root, parent);
    const response = handler(new Request(userContentOrigin));
    const document = await response.text();
    assert.ok(document.includes("localhost:5555"));
    assert.ok(document.includes("unchanged"));
    assert.ok(!document.includes("https://claude.ai"));
    assert.equal(
      await handler(new Request(userContentOrigin + "/asset.js")).text(),
      asset,
    );
    assert.equal(
      handler(new Request("https://unrelated.test/asset.js")).status,
      403,
    );
    assert.equal(
      handler(new Request(userContentOrigin + "/uncaptured.js")).status,
      404,
    );
    assert.equal(
      handler(
        new Request(userContentOrigin, { method: "POST", body: "private" }),
      ).status,
      403,
    );
    assert.ok(
      response.headers
        .get("Content-Security-Policy")
        ?.includes("frame-ancestors 'self' " + parent),
    );
    assert.throws(
      () => configureUserContentDocument(html, "http://unrelated.test"),
      /secure or loopback official UI origin/,
    );
    const web = createUserContentHandler(root, "https://app.example.test", "https://preview.example.test");
    assert.ok((await web(new Request("https://preview.example.test/")).text()).includes("https://app.example.test"));
    assert.throws(() => createUserContentHandler(root, "https://app.example.test", "https://app.example.test:4350"), /separate/);
    const server = await startOfficialUserContentServer({ root, parentOrigin: "http://127.0.0.1:5555" });
    try {
      const loaded = await fetch(server.origin);
      assert.equal(loaded.status, 200);
      assert.ok((await loaded.text()).includes("http://127.0.0.1:5555"));
      assert.match(loaded.headers.get("content-security-policy")!, /worker-src 'self' blob:/);
      assert.equal(await (await fetch(server.origin + "/asset.js")).text(), asset);
      assert.equal((await fetch(server.origin + "/api/account")).status, 404);
    } finally { await server.close(); }
    fs.writeFileSync(path.join(root, "asset.js"), "changed");
    const fresh = createUserContentHandler(root, parent);
    assert.throws(
      () => fresh(new Request(userContentOrigin + "/asset.js")),
      /checksum/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the official MCP App proxy keeps its opaque widget and applies declared sources for one parent", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-mcp-app-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = fs.readFileSync(new URL("../electron/official-ui/assets/mcp_apps.html", import.meta.url), "utf8");
  fs.writeFileSync(path.join(root, "mcp_apps.html"), original);
  fs.writeFileSync(path.join(root, "manifest.json"), '{"assets":[]}');
  const parent = "https://app.example.test:8443";
  const preview = "https://preview.example.test";
  const handle = createUserContentHandler(root, parent, preview);
  const url = new URL("/mcp_apps", preview);
  url.search = new URLSearchParams({
    "resource-src": "https://*.cdn.example.com https://assets.claude.ai/bundle.js",
    "connect-src": "wss://updates.example.com https://bad.example.com; frame-ancestors *",
    "frame-src": "https://widgets.example.com https://127.0.0.1 wss://frames.example.com",
    "base-uri": "https://base.example.com",
    "stable-origin": "true",
  }).toString();
  const response = handle(new Request(url));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), original.replace(
    '["https://claude.ai","https://preview.claude.ai","app://localhost"]',
    JSON.stringify([parent]),
  ));
  const policy = response.headers.get("Content-Security-Policy")?.split("; ") ?? [];
  assert.ok(policy.includes(`frame-ancestors ${parent}`));
  assert.ok(policy.includes("frame-src blob: data: https://widgets.example.com"));
  assert.ok(policy.includes("base-uri 'self'"));
  assert.ok(policy.includes("script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: https://*.cdn.example.com https://assets.claude.ai"));
  assert.ok(policy.includes(`connect-src 'self' ${preview} blob: data: wss://updates.example.com`));
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(await handle(new Request(url, { method: "HEAD" })).text(), "");
  assert.equal(handle(new Request(url, { method: "POST" })).status, 403);
  assert.equal(handle(new Request(new URL("/mcp_apps", parent))).status, 403);
});
