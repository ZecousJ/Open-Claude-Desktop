import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createIsolatedWebUserContent,
  type PreviewAsset,
  type PreviewIdentity,
} from "../../runner/src/official-usercontent-host";

const parentOrigin = "http://127.0.0.1:5199";
const previewOrigin = "http://localhost:5200";
// Inert fixture bytes are hashed/returned, never executed or served by these tests.
const document =
  '<html><script>self.__next_f.push([1,"{\\\"allowedParentOrigins\\\":[\\\"https://claude.ai\\\"],\\\"defaultParentOrigin\\\":\\\"claude.ai\\\"}"])</script></html>';
const asset = (
  path = "/",
  text = document,
  contentType = "text/html",
): PreviewAsset => {
  const bytes = new TextEncoder().encode(text);
  return {
    path,
    bytes,
    contentType,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};
const request = (
  path = "/?domain=127.0.0.1&parentOrigin=" + encodeURIComponent(parentOrigin),
  init?: RequestInit,
) => new Request(previewOrigin + path, init);
function setup() {
  let current: PreviewIdentity | null = { account: "a", session: 1 };
  const assets = [
    asset(),
    asset("/_next/fixture.js", "/* inert fixture */", "text/javascript"),
  ];
  const options = {
    parentOrigin,
    previewOrigin,
    identity: { account: "a", session: 1 },
    currentIdentity: () => current,
    assets,
  };
  return {
    options,
    host: createIsolatedWebUserContent(options),
    set: (value: PreviewIdentity | null) => {
      current = value;
    },
  };
}
test("pinned document configuration and static assets only; no credentials/CORS or external CSP", async () => {
  const { host } = setup();
  const response = await host.handle(request());
  assert.equal(response.status, 200);
  assert.match(await response.text(), /127\.0\.0\.1:5199/);
  const csp = response.headers.get("content-security-policy")!;
  assert.match(csp, /frame-ancestors http:\/\/127\.0\.0\.1:5199/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /worker-src 'none'/);
  assert.doesNotMatch(csp, /claudeusercontent|https:|\*/);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await host.handle(request("/_next/fixture.js"))).status, 200);
  assert.equal(
    await (await host.handle(request(undefined, { method: "HEAD" }))).text(),
    "",
  );
});
test("distinct cookie hostname is mandatory; external/credential/path origins rejected", () => {
  const { options } = setup();
  for (const value of [
    "http://127.0.0.1:5200",
    "https://example.com",
    "http://localhost:5200/path",
    "http://user@localhost:5200",
  ]) {
    assert.throws(() =>
      createIsolatedWebUserContent({ ...options, previewOrigin: value }),
    );
  }
});
test("cross-parent, cookies, bearer, writes and uncaptured resources fail closed", async () => {
  const { host } = setup();
  for (const req of [
    request("/"),
    request("/?domain=127.0.0.1&parentOrigin=http://evil.invalid"),
    request(undefined, { headers: { cookie: "irrelevant=fixture" } }),
    request(undefined, { headers: { authorization: "Bearer fixture" } }),
    request(undefined, { method: "POST" }),
    new Request("http://127.0.0.1:5200/"),
  ])
    assert.equal((await host.handle(req)).status, 403);
  for (const path of [
    "/api/convert-pdf",
    "/api/proxy",
    "/artifact/published",
    "/missing.js",
  ])
    assert.equal((await host.handle(request(path))).status, 404);
});
test("logout, account switch, session rotation and explicit revocation retire host", async () => {
  for (const value of [
    null,
    { account: "b", session: 1 },
    { account: "a", session: 2 },
  ]) {
    const s = setup();
    s.set(value);
    assert.equal((await s.host.handle(request())).status, 410);
  }
  const s = setup();
  s.host.revoke();
  assert.equal((await s.host.handle(request())).status, 410);
  const retired = setup();
  retired.set(null);
  assert.equal((await retired.host.handle(request())).status, 410);
  retired.set({ account: "a", session: 1 });
  assert.equal((await retired.host.handle(request())).status, 410);
});
test("asset snapshot integrity, traversal, duplicate and malformed document validation", async () => {
  const { options, host } = setup();
  options.assets[1].bytes.fill(0);
  assert.equal(
    await (await host.handle(request("/_next/fixture.js"))).text(),
    "/* inert fixture */",
  );
  for (const assets of [
    [{ ...asset(), sha256: "0".repeat(64) }],
    [asset(), asset()],
    [asset(), asset("/../bad.js", "", "text/javascript")],
    [asset("/", "<html>missing config</html>")],
  ])
    assert.throws(() => createIsolatedWebUserContent({ ...options, assets }));
});

test("identity lookup failure or mid-request rotation never releases resource bytes", async () => {
  const { options } = setup();
  const failed = createIsolatedWebUserContent({
    ...options,
    currentIdentity: () => {
      throw Error("unavailable");
    },
  });
  assert.equal((await failed.handle(request())).status, 410);
  let reads = 0;
  const changed = createIsolatedWebUserContent({
    ...options,
    currentIdentity: () => ({ account: "a", session: ++reads === 1 ? 1 : 2 }),
  });
  assert.equal((await changed.handle(request())).status, 410);
});

test("Office conversion uses the current preview session and original token contract", async () => {
  const s = setup();
  let converted = 0;
  const host = createIsolatedWebUserContent({
    ...s.options,
    convertDocument: async (data, extension) => {
      converted++;
      assert.equal(extension, "docx");
      assert.deepEqual(data, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      return Buffer.from("%PDF-1.4\nfixture");
    },
  });
  const token = host.issueDocumentPreviewToken();
  const conversion = (token: string) =>
    request("/api/convert-pdf", {
      method: "POST",
      headers: {
        "content-type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "x-convert-pdf-token": token,
      },
      body: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    });
  assert.match(
    (await host.handle(request())).headers.get("content-security-policy")!,
    /connect-src 'self'/,
  );
  assert.equal((await host.handle(conversion("unknown"))).status, 401);
  assert.equal(converted, 0);
  const result = await host.handle(conversion(token));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("content-type"), "application/pdf");
  assert.equal(await result.text(), "%PDF-1.4\nfixture");
  assert.equal(converted, 1);
  s.set({ account: "b", session: 2 });
  assert.equal((await host.handle(conversion(token))).status, 410);
  assert.throws(() => host.issueDocumentPreviewToken(), /Sign in/);
  assert.equal(converted, 1);
});
