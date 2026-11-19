import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  defaultUserData,
  emailFromZecousStore,
  readSignInHint,
  zecousHandoff,
  zecousStoreFile,
} from "../../electron/updates/zecous-handoff";
import { defaultClaudexServiceUrl } from "../../shared/claudex-service";
import { loadSub2ApiConfig } from "../../server/sub2api-config";

const jwt = (claims: object) =>
  [
    Buffer.from('{"alg":"HS256"}').toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature",
  ].join(".");

function temporary(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-handoff-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the default service is one constant", () => {
  assert.equal(defaultClaudexServiceUrl, "https://claudex.zecous.cn");
});

test("ZecousAI's store is found where Electron keeps userData", () => {
  assert.equal(
    zecousStoreFile("darwin", {}, "/Users/z"),
    "/Users/z/Library/Application Support/ZecousAI/desktop-store.json",
  );
  assert.equal(
    zecousStoreFile(
      "win32",
      { APPDATA: "C:\\Users\\z\\AppData\\Roaming" },
      "C:\\Users\\z",
    ),
    "C:\\Users\\z\\AppData\\Roaming\\ZecousAI\\desktop-store.json",
  );
  assert.equal(
    defaultUserData("Claudex", "win32", { APPDATA: "C:\\R" }, "C:\\U"),
    "C:\\R\\Claudex",
  );
});

test("the email comes only from an address claim, never a user id", () => {
  const store = (auth: object) => JSON.stringify({ auth });
  assert.equal(
    emailFromZecousStore(
      store({ accessToken: jwt({ sub: "42", email: "Person@Example.com" }) }),
    ),
    "person@example.com",
  );
  assert.equal(
    emailFromZecousStore(
      store({
        accessToken: jwt({ sub: "42" }),
        refreshToken: jwt({ sub: "42" }),
        subject: "42",
      }),
    ),
    undefined,
  );
  assert.equal(emailFromZecousStore("not json"), undefined);
  assert.equal(emailFromZecousStore(store({ accessToken: "a.b" })), undefined);
});

test("the handoff writes the service and the hint once, and never copies tokens", (t) => {
  const root = temporary(t);
  const userData = path.join(root, "Claudex");
  const zecousStore = path.join(root, "ZecousAI", "desktop-store.json");
  const serviceUrl = defaultClaudexServiceUrl;
  assert.deepEqual(zecousHandoff({ userData, zecousStore, serviceUrl }), {
    configured: false,
  });
  fs.mkdirSync(path.dirname(zecousStore), { recursive: true });
  const access = jwt({ sub: "7", email: "a@zecous.cn" });
  fs.writeFileSync(
    zecousStore,
    JSON.stringify({
      auth: { accessToken: access, refreshToken: "refresh-secret" },
    }),
  );
  assert.deepEqual(zecousHandoff({ userData, zecousStore, serviceUrl }), {
    configured: true,
    email: "a@zecous.cn",
  });
  assert.equal(loadSub2ApiConfig(userData, {})?.baseUrl, serviceUrl);
  assert.equal(readSignInHint(userData), "a@zecous.cn");
  const written = fs
    .readdirSync(path.join(userData, "backend"))
    .map((name) =>
      fs.readFileSync(path.join(userData, "backend", name), "utf8"),
    )
    .join("\n");
  assert.ok(!written.includes("refresh-secret") && !written.includes(access));
  // A second run leaves an operator's own choice alone.
  fs.writeFileSync(
    path.join(userData, "backend", "sub2api.json"),
    JSON.stringify({ version: 1, baseUrl: "https://other.example" }),
  );
  assert.equal(
    zecousHandoff({ userData, zecousStore, serviceUrl }).configured,
    false,
  );
  assert.equal(
    loadSub2ApiConfig(userData, {})?.baseUrl,
    "https://other.example",
  );
});

test("a ZecousAI user who never signed in there still gets the service", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-handoff-"));
  const userData = path.join(home, "Claudex");
  const zecousStore = path.join(home, "ZecousAI", "desktop-store.json");
  const serviceUrl = "https://claudex.example";
  // Without the flag nothing is known about ZecousAI: leave Claudex alone.
  assert.deepEqual(zecousHandoff({ userData, zecousStore, serviceUrl }), {
    configured: false,
  });
  // The bridge (or a start from ZecousAI.app) knows: write the service only.
  assert.deepEqual(
    zecousHandoff({ userData, zecousStore, serviceUrl, fromZecousAI: true }),
    { configured: true },
  );
  assert.equal(loadSub2ApiConfig(userData, {})?.baseUrl, serviceUrl);
  assert.equal(readSignInHint(userData), undefined);
});
