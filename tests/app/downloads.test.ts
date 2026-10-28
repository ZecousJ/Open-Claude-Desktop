import test from "node:test";
import assert from "node:assert/strict";
import { parseApps } from "../../src/downloads/apps";
import { formatWebRoute, parseWebRoute } from "../../src/web/routes";

test("the downloads page has its own address", () => {
  assert.deepEqual(parseWebRoute("/downloads"), { kind: "downloads" });
  assert.deepEqual(parseWebRoute("/downloads/"), { kind: "downloads" });
  assert.equal(formatWebRoute({ kind: "downloads" }), "/downloads");
});

test("the apps answer keeps https downloads only", () => {
  const apps = parseApps({
    code: 0,
    data: {
      desktop: {
        version: "0.0.11",
        downloads: {
          "darwin-arm64": "https://d.example/a.zip",
          "win32-x64": "http://d.example/b.exe",
        },
      },
      android: { version: "0.4.0", url: "https://d.example/c.apk" },
      ios: { url: "javascript:alert(1)" },
    },
  });
  assert.deepEqual(apps, {
    desktop: {
      version: "0.0.11",
      downloads: { "darwin-arm64": "https://d.example/a.zip" },
    },
    android: { version: "0.4.0", url: "https://d.example/c.apk" },
    ios: undefined,
  });
  assert.deepEqual(parseApps({ desktop: null, android: null, ios: null }), {
    android: undefined,
    ios: undefined,
  });
  assert.equal(parseApps(null), null);
});
