/**
 * The Browser panel's address bar and page rules (R8-A): what a typed
 * address opens, where pages may go, blocked domains, cookie partitions,
 * load error wording, and the CDP helpers that need no page.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  describeLoadError,
  displayAddress,
  fileAllowed,
  hostBlocked,
  isLocalDevHost,
  isPrivateNetworkHost,
  keepCookiesOf,
  normalizeAddress,
  pageOrigin,
} from "../../shared/browser";
import {
  navigationAllowed,
  requestBlocked,
  subframeRefused,
  windowOpenDecision,
} from "../../electron/browser/navigation-guard";
import {
  BrowserPartitions,
  chromeUserAgent,
  partitionName,
  perSessionPrefix,
  previewPartitionName,
  type PartitionSession,
} from "../../electron/browser/partitions";
import {
  describeKey,
  formatAXTree,
  redactUrl,
  Ring,
  type AXNode,
} from "../../electron/browser/cdp-support";

const url = (input: string, fileRoots: string[] = []) => {
  const result = normalizeAddress(input, { fileRoots });
  return result.ok ? result.url : `refused: ${result.message}`;
};

test("addresses with a scheme open only as web pages, about:blank or chosen files", () => {
  assert.equal(url("https://example.com"), "https://example.com/");
  assert.equal(
    url("  http://example.com/a?b=1#c "),
    "http://example.com/a?b=1#c",
  );
  assert.equal(url("HTTPS://Example.COM/Path"), "https://example.com/Path");
  assert.equal(url("about:blank"), "about:blank");
  for (const refused of [
    "javascript:alert(1)",
    "data:text/html,<h1>x</h1>",
    "chrome://settings",
    "devtools://devtools/bundled/inspector.html",
    "claudex://settings",
    "mailto:someone@example.com",
    "ftp://example.com/file",
    "about:config",
  ])
    assert.match(url(refused), /^refused: /, refused);
  assert.match(url("https://user:pw@example.com/"), /user name or password/);
});

test("addresses without a scheme: local and private hosts over http, domains over https, words refused", () => {
  assert.equal(url("localhost"), "http://localhost/");
  assert.equal(url("localhost:5173"), "http://localhost:5173/");
  assert.equal(url("localhost:3000/app?x=1"), "http://localhost:3000/app?x=1");
  assert.equal(url("127.0.0.1:8000"), "http://127.0.0.1:8000/");
  assert.equal(url("[::1]:4321/docs"), "http://[::1]:4321/docs");
  assert.equal(url("app.localhost:3000"), "http://app.localhost:3000/");
  assert.equal(url("myapp.test"), "http://myapp.test/");
  assert.equal(url("192.168.1.20:8080"), "http://192.168.1.20:8080/");
  assert.equal(url("10.0.0.5"), "http://10.0.0.5/");
  assert.equal(url("example.com"), "https://example.com/");
  assert.equal(
    url("docs.example.co.uk/guide"),
    "https://docs.example.co.uk/guide",
  );
  assert.equal(url("example.com:8443/x"), "https://example.com:8443/x");
  assert.equal(url("8.8.8.8"), "https://8.8.8.8/");
  // No search: words that are not an address ask for a URL.
  assert.equal(
    url("how to center a div"),
    "refused: Enter a URL, like example.com.",
  );
  assert.equal(url("react"), "refused: Enter a URL, like example.com.");
  assert.equal(url(""), "refused: Enter a URL.");
  assert.equal(url("   "), "refused: Enter a URL.");
  assert.match(url("x".repeat(9000)), /too long/);
});

test("file pages open only inside a folder the person chose with Open HTML file…", () => {
  const roots = ["/Users/me/site"];
  assert.equal(
    url("file:///Users/me/site/index.html", roots),
    "file:///Users/me/site/index.html",
  );
  assert.equal(
    url("file:///Users/me/site/sub/page.html", roots),
    "file:///Users/me/site/sub/page.html",
  );
  assert.match(url("file:///Users/me/site/index.html"), /Open HTML file/);
  assert.match(url("file:///Users/me/other.html", roots), /Open HTML file/);
  assert.match(url("file:///Users/me/sitex/a.html", roots), /Open HTML file/);
  assert.match(url("file://server/share/a.html", roots), /this computer/);
  assert.equal(
    fileAllowed("file:///Users/me/site/../secret.html", roots),
    false,
  );
  assert.equal(
    fileAllowed("file:///Users/me/site/%2e%2e/secret.html", roots),
    false,
  );
  assert.equal(
    fileAllowed("file:///C:/Work/site/a.html", ["C:\\Work\\site"]),
    true,
  );
  assert.equal(
    fileAllowed("file:///c:/work/site/a.html", ["C:\\Work\\Site"]),
    true,
  );
  assert.equal(fileAllowed("https://example.com/", roots), false);
  // Hidden files inside a chosen folder stay closed.
  assert.equal(
    fileAllowed("file:///Users/me/.ssh/id_rsa", ["/Users/me"]),
    false,
  );
  assert.equal(
    fileAllowed("file:///Users/me/site/.env", ["/Users/me/site"]),
    false,
  );
  assert.equal(
    fileAllowed("file:///Users/me/.hidden/site/a.html", [
      "/Users/me/.hidden/site",
    ]),
    true,
  );
});

test("local, private and blocked hosts", () => {
  for (const host of [
    "localhost",
    "LOCALHOST:3000",
    "a.localhost",
    "127.0.0.1",
    "127.1.2.3:9",
    "[::1]",
    "[::1]:80",
  ])
    assert.equal(isLocalDevHost(host), true, host);
  for (const host of ["localhost.com", "example.com", "10.0.0.1", "[::2]"])
    assert.equal(isLocalDevHost(host), false, host);
  for (const host of [
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1:80",
    "169.254.1.1",
    "box.local",
    "site.test",
  ])
    assert.equal(isPrivateNetworkHost(host), true, host);
  for (const host of ["172.32.0.1", "8.8.8.8", "example.com", "300.1.1.1"])
    assert.equal(isPrivateNetworkHost(host), false, host);
  const blocked = ["example.com", "*.bad.org", " Social.NET "];
  assert.equal(hostBlocked("example.com", blocked), true);
  assert.equal(hostBlocked("www.example.com:443", blocked), true);
  assert.equal(hostBlocked("EXAMPLE.COM.", blocked), true);
  assert.equal(hostBlocked("notexample.com", blocked), false);
  assert.equal(hostBlocked("x.bad.org", blocked), true);
  assert.equal(hostBlocked("bad.org", blocked), true);
  assert.equal(hostBlocked("m.social.net", blocked), true);
  assert.equal(hostBlocked("example.org", blocked), false);
  assert.equal(hostBlocked("example.com", []), false);
});

test("the guard stops navigations, frames and requests the rules refuse", () => {
  const options = { fileRoots: ["/srv/site"], blockedDomains: ["blocked.com"] };
  assert.deepEqual(navigationAllowed("https://ok.com/", options), {
    allow: true,
  });
  assert.deepEqual(navigationAllowed("https://a.blocked.com/", options), {
    allow: false,
    reason: "blocked",
  });
  assert.deepEqual(navigationAllowed("javascript:void(0)", options), {
    allow: false,
    reason: "scheme",
  });
  assert.deepEqual(navigationAllowed("file:///etc/passwd", options), {
    allow: false,
    reason: "file",
  });
  assert.deepEqual(navigationAllowed("file:///srv/site/a.html", options), {
    allow: true,
  });
  assert.deepEqual(navigationAllowed("about:blank", options), { allow: true });
  assert.deepEqual(navigationAllowed("about:srcdoc", options), {
    allow: false,
    reason: "scheme",
  });
  assert.equal(windowOpenDecision("https://ok.com/popup", options), "tab");
  assert.equal(windowOpenDecision("https://blocked.com/", options), "deny");
  assert.equal(windowOpenDecision("mailto:a@b.c", options), "deny");
  assert.equal(windowOpenDecision("file:///srv/site/b.html", options), "tab");
  assert.equal(windowOpenDecision("file:///etc/hosts", options), "deny");
  assert.equal(
    requestBlocked("https://cdn.blocked.com/x.js", options.blockedDomains),
    true,
  );
  assert.equal(
    requestBlocked("wss://blocked.com/socket", options.blockedDomains),
    true,
  );
  assert.equal(
    requestBlocked("data:text/plain,blocked.com", options.blockedDomains),
    false,
  );
  assert.equal(requestBlocked("https://ok.com/", []), false);
  assert.equal(subframeRefused("https://blocked.com/frame", options), true);
  assert.equal(subframeRefused("file:///etc/hosts", options), true);
  assert.equal(subframeRefused("file:///srv/site/frame.html", options), false);
  assert.equal(subframeRefused("chrome://gpu", options), true);
  assert.equal(subframeRefused("about:srcdoc", options), false);
  assert.equal(subframeRefused("https://ok.com/embed", options), false);
});

test("the address bar shows host and path when not editing", () => {
  assert.equal(displayAddress("https://example.com/"), "example.com");
  assert.equal(
    displayAddress("https://www.example.com/a/b?c=1#d"),
    "www.example.com/a/b?c=1#d",
  );
  assert.equal(
    displayAddress("http://localhost:5173/"),
    "http://localhost:5173",
  );
  assert.equal(displayAddress("about:blank"), "");
  assert.equal(displayAddress(""), "");
  assert.equal(
    displayAddress("file:///Users/me/site/My%20Page.html"),
    "/Users/me/site/My Page.html",
  );
  assert.equal(pageOrigin("https://example.com/a"), "https://example.com");
  assert.equal(pageOrigin("file:///a.html"), "");
  assert.equal(pageOrigin("not a url"), "");
});

test("load errors read as a title and a line", () => {
  const at = (description: string, url = "http://localhost:5173/") =>
    describeLoadError({ code: -1, description, url });
  assert.deepEqual(at("ERR_CONNECTION_REFUSED"), {
    title: "This site can't be reached",
    detail: "localhost:5173 refused to connect.",
  });
  assert.match(
    at("ERR_NAME_NOT_RESOLVED", "https://nope.invalid/").detail,
    /nope\.invalid's server address/,
  );
  assert.equal(
    at("ERR_CERT_AUTHORITY_INVALID").title,
    "Your connection isn't private",
  );
  assert.equal(at("BLOCKED_BY_ADMINISTRATOR").title, "This site is blocked");
  assert.equal(at("ERR_INTERNET_DISCONNECTED").title, "No internet");
  assert.match(at("ERR_UNSAFE_PORT").detail, /ERR_UNSAFE_PORT/);
  assert.match(at("net::ERR_TIMED_OUT").detail, /took too long/);
});

test("Keep cookies choices map to one jar per account, per session when asked", () => {
  assert.equal(keepCookiesOf("always"), "always");
  assert.equal(keepCookiesOf("per-session"), "per-session");
  assert.equal(keepCookiesOf("forever"), "until-quit");
  assert.equal(keepCookiesOf(undefined), "until-quit");
  const quit = partitionName("until-quit", "acct-1", "c-1");
  assert.equal(quit, partitionName("until-quit", "acct-1", "c-2"));
  assert.doesNotMatch(quit, /^persist:/);
  assert.notEqual(quit, partitionName("until-quit", "acct-2", "c-1"));
  const always = partitionName("always", "acct-1", "c-1");
  assert.match(always, /^persist:claudex-browser-[0-9a-f]{16}$/);
  assert.equal(always, partitionName("always", "acct-1", "c-9"));
  const own = partitionName("per-session", "acct-1", "c-1");
  assert.notEqual(own, partitionName("per-session", "acct-1", "c-2"));
  assert.ok(own.startsWith(`persist:${perSessionPrefix("acct-1")}`));
  assert.ok(!own.startsWith(`persist:${perSessionPrefix("acct-2")}`));
  // Account ids never appear in folder names.
  assert.doesNotMatch(
    partitionName("per-session", "me@example.com", "c-1"),
    /example/,
  );
});

class FakeSession implements PartitionSession {
  handlers = new Map<string, (...args: any[]) => void>();
  permission?: (c: unknown, p: string, cb: (granted: boolean) => void) => void;
  check?: () => boolean;
  device?: () => boolean;
  beforeRequest?: (
    d: { url: string },
    cb: (r: { cancel?: boolean }) => void,
  ) => void;
  userAgent =
    "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) claudex/0.1.0 Chrome/140.0.0.0 Electron/44.4.3 Safari/537.36";
  cleared: string[] = [];
  setPermissionRequestHandler(h: any) {
    this.permission = h;
  }
  setPermissionCheckHandler(h: any) {
    this.check = h;
  }
  setDevicePermissionHandler(h: any) {
    this.device = h;
  }
  on(event: string, listener: (...args: any[]) => void) {
    this.handlers.set(event, listener);
    return this;
  }
  webRequest = {
    onBeforeRequest: (_filter: { urls: string[] }, listener: any) => {
      this.beforeRequest = listener;
    },
  };
  getUserAgent() {
    return this.userAgent;
  }
  setUserAgent(value: string) {
    this.userAgent = value;
  }
  async clearStorageData() {
    this.cleared.push("storage");
  }
  async clearCache() {
    this.cleared.push("cache");
  }
  async clearAuthCache() {
    this.cleared.push("auth");
  }
}

test("preview storage shares all saved sites, scopes session jars and isolates ephemeral workspaces", async () => {
  const partition = previewPartitionName(
    "always",
    "a",
    "/workspace",
    "web",
    "c1",
  );
  assert.equal(partition, partitionName("always", "a", "c1"));
  assert.equal(
    partition,
    previewPartitionName("always", "a", "/workspace", "web", "c2"),
  );
  assert.notEqual(
    partition,
    previewPartitionName("always", "b", "/workspace", "web", "c1"),
  );
  assert.equal(
    partition,
    previewPartitionName("always", "a", "/other", "web", "c1"),
  );
  assert.equal(
    partition,
    previewPartitionName("always", "a", "/workspace", "api", "c1"),
  );
  assert.notEqual(
    previewPartitionName("per-session", "a", "/workspace", "web", "c1"),
    previewPartitionName("per-session", "a", "/workspace", "web", "c2"),
  );
  assert.equal(
    previewPartitionName("per-session", "a", "/workspace", "web", "c1"),
    previewPartitionName("per-session", "a", "/other", "api", "c1"),
  );
  assert.equal(
    previewPartitionName("until-quit", "a", "/workspace", "web", "c1"),
    previewPartitionName("until-quit", "a", "/workspace", "api", "c2"),
  );
  assert.notEqual(
    previewPartitionName("until-quit", "a", "/workspace", "web", "c1"),
    previewPartitionName("until-quit", "a", "/other", "web", "c1"),
  );
  const sessions = new Map<string, FakeSession>();
  const jars = new BrowserPartitions({
    fromPartition: (name) => {
      const session = new FakeSession();
      sessions.set(name, session);
      return session;
    },
    blockedDomains: () => [],
    downloadRefused: () => {},
  });
  const ephemeral = previewPartitionName(
    "until-quit",
    "a",
    "/workspace",
    "web",
    "c1",
  );
  const other = previewPartitionName("always", "b", "/workspace", "web", "c1");
  const ordinary = partitionName("always", "a", "c1");
  for (const name of [partition, ephemeral, other, ordinary])
    jars.session(name);
  await jars.clearPreviews("a");
  assert.deepEqual(sessions.get(partition)?.cleared, [
    "storage",
    "cache",
    "auth",
  ]);
  assert.deepEqual(sessions.get(ephemeral)?.cleared, [
    "storage",
    "cache",
    "auth",
  ]);
  assert.deepEqual(sessions.get(other)?.cleared, []);
  assert.deepEqual(sessions.get(ordinary)?.cleared, [
    "storage",
    "cache",
    "auth",
  ]);
});

test("deleting a conversation clears its preview session jars without affecting another session or workspace cookies", async () => {
  const sessions = new Map<string, FakeSession>();
  const jars = new BrowserPartitions({
    fromPartition: (name) => {
      const session = new FakeSession();
      sessions.set(name, session);
      return session;
    },
    blockedDomains: () => [],
    downloadRefused: () => {},
  });
  const removed = previewPartitionName(
    "per-session",
    "a",
    "/workspace",
    "web",
    "c1",
  );
  const kept = previewPartitionName(
    "per-session",
    "a",
    "/workspace",
    "web",
    "c2",
  );
  const workspace = previewPartitionName(
    "always",
    "a",
    "/workspace",
    "web",
    "c1",
  );
  for (const name of [removed, kept, workspace]) jars.session(name);
  await jars.forgetConversation("a", "c1");
  assert.deepEqual(sessions.get(removed)?.cleared, [
    "storage",
    "cache",
    "auth",
  ]);
  assert.deepEqual(sessions.get(kept)?.cleared, []);
  assert.deepEqual(sessions.get(workspace)?.cleared, []);
});

test("each partition refuses permissions, devices and downloads, and blocks domains", async () => {
  const sessions = new Map<string, FakeSession>();
  const refused: string[] = [];
  let blocked = ["blocked.com"];
  const jars = new BrowserPartitions({
    fromPartition: (name) => {
      const s = new FakeSession();
      sessions.set(name, s);
      return s;
    },
    blockedDomains: () => blocked,
    downloadRefused: (_contents, filename) => refused.push(filename),
  });
  const s = jars.session("persist:x");
  assert.equal(jars.session("persist:x"), s, "configured once");
  let granted: boolean | undefined;
  s.permission!({}, "media", (value) => (granted = value));
  assert.equal(granted, false);
  assert.equal(s.check!(), false);
  assert.equal(s.device!(), false);
  let prevented = false;
  let chose: unknown = "unset";
  s.handlers.get("select-hid-device")!(
    { preventDefault: () => (prevented = true) },
    {},
    (id?: string) => (chose = id),
  );
  assert.equal(prevented, true);
  assert.equal(chose, undefined);
  let downloadPrevented = false;
  s.handlers.get("will-download")!(
    { preventDefault: () => (downloadPrevented = true) },
    { getFilename: () => "report.pdf" },
    {},
  );
  assert.equal(downloadPrevented, true);
  assert.deepEqual(refused, ["report.pdf"]);
  let cancel: boolean | undefined;
  s.beforeRequest!(
    { url: "https://x.blocked.com/a.js" },
    (r) => (cancel = r.cancel),
  );
  assert.equal(cancel, true);
  s.beforeRequest!(
    { url: "https://fine.com/a.js" },
    (r) => (cancel = r.cancel),
  );
  assert.equal(cancel, false);
  blocked = [];
  s.beforeRequest!(
    { url: "https://x.blocked.com/a.js" },
    (r) => (cancel = r.cancel),
  );
  assert.equal(cancel, false, "the policy is read at each request");
  assert.doesNotMatch(s.userAgent, /Electron|claudex/);
  assert.match(s.userAgent, /Chrome\/140/);
  assert.equal(chromeUserAgent("A Electron/1.2.3 B claudex/9 C"), "A B C");
  await jars.clearFor("always", "acct", []);
  assert.deepEqual(sessions.get(partitionName("always", "acct", ""))!.cleared, [
    "storage",
    "cache",
    "auth",
  ]);
  jars.session(partitionName("per-session", "acct", "c-1"));
  jars.session(partitionName("per-session", "other", "c-1"));
  await jars.clearFor("per-session", "acct", ["c-2"]);
  assert.equal(
    sessions.get(partitionName("per-session", "acct", "c-1"))!.cleared.length,
    3,
  );
  assert.equal(
    sessions.get(partitionName("per-session", "acct", "c-2"))!.cleared.length,
    3,
  );
  assert.equal(
    sessions.get(partitionName("per-session", "other", "c-1"))!.cleared.length,
    0,
  );
  // A conversation that never had its own browser leaves nothing to clear.
  const before = sessions.size;
  await jars.forgetConversation("acct", "c-never");
  assert.equal(sessions.size, before);
});

test("keys and chords become CDP key events", () => {
  assert.deepEqual(describeKey("Enter"), {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    modifiers: 0,
    text: "\r",
  });
  assert.deepEqual(describeKey("cmd+a", "darwin"), {
    key: "a",
    code: "KeyA",
    keyCode: 65,
    modifiers: 4,
    commands: ["selectAll"],
  });
  assert.equal(describeKey("ctrl+a", "win32").commands, undefined);
  assert.equal(describeKey("shift+a").key, "A");
  assert.equal(describeKey("shift+a").text, "A");
  assert.equal(describeKey("ctrl+shift+Tab").modifiers, 10);
  assert.equal(describeKey("alt+ArrowLeft").keyCode, 37);
  assert.equal(describeKey("F5").keyCode, 116);
  assert.equal(describeKey("7").code, "Digit7");
  assert.throws(() => describeKey("hyper+a"), /not a modifier/);
  assert.throws(() => describeKey("Banana"), /not a key/);
});

test("the network log hides secrets in addresses; logs keep the last entries", () => {
  assert.equal(
    redactUrl("https://api.example.com/v1?access_token=abc&page=2&apiKey=zz"),
    "https://api.example.com/v1?access_token=REDACTED&page=2&apiKey=REDACTED",
  );
  assert.equal(redactUrl("https://u:p@example.com/"), "https://example.com/");
  assert.equal(
    redactUrl("https://example.com/?q=1"),
    "https://example.com/?q=1",
  );
  const ring = new Ring<number>(3);
  for (let i = 0; i < 5; i++) ring.push(i);
  assert.deepEqual(ring.values(), [2, 3, 4]);
  assert.equal(
    ring.find((n) => n < 4),
    3,
  );
});

test("the accessibility snapshot lists elements with stable refs", () => {
  const nodes: AXNode[] = [
    {
      nodeId: "1",
      role: { value: "RootWebArea" },
      name: { value: "Page" },
      childIds: ["2", "3", "6"],
      backendDOMNodeId: 10,
    },
    {
      nodeId: "2",
      parentId: "1",
      role: { value: "generic" },
      childIds: ["4"],
      backendDOMNodeId: 11,
    },
    {
      nodeId: "3",
      parentId: "1",
      role: { value: "heading" },
      name: { value: "Welcome" },
      childIds: ["5"],
      backendDOMNodeId: 12,
    },
    {
      nodeId: "4",
      parentId: "2",
      role: { value: "button" },
      name: { value: "Sign in" },
      backendDOMNodeId: 13,
      properties: [
        { name: "focused", value: { value: true } },
        { name: "disabled", value: { value: false } },
      ],
    },
    {
      nodeId: "5",
      parentId: "3",
      role: { value: "StaticText" },
      name: { value: "Welcome" },
    },
    {
      nodeId: "6",
      parentId: "1",
      role: { value: "textbox" },
      name: { value: "Email" },
      value: { value: "me@x.com" },
      backendDOMNodeId: 14,
    },
  ];
  const refs = new Map<number, string>();
  let next = 1;
  const refFor = (id: number) => {
    if (!refs.has(id)) refs.set(id, `ref_${next++}`);
    return refs.get(id)!;
  };
  const tree = formatAXTree(nodes, refFor);
  assert.equal(
    tree,
    [
      '- RootWebArea "Page" [ref_1]',
      '  - button "Sign in" [ref_2] (focused)',
      '  - heading "Welcome" [ref_3]',
      '    - text "Welcome"',
      '  - textbox "Email" [ref_4] value="me@x.com"',
    ].join("\n"),
  );
  assert.equal(formatAXTree(nodes, refFor), tree, "same refs the second time");
  assert.equal(
    formatAXTree(nodes, refFor, { interactiveOnly: true }),
    [
      '- button "Sign in" [ref_2] (focused)',
      '- textbox "Email" [ref_4] value="me@x.com"',
    ].join("\n"),
  );
  assert.equal(
    formatAXTree(nodes, refFor, { rootBackendId: 12 }),
    ['- heading "Welcome" [ref_3]', '  - text "Welcome"'].join("\n"),
  );
  assert.match(
    formatAXTree(nodes, refFor, { maxChars: 40 }),
    /the page is longer/,
  );
});
