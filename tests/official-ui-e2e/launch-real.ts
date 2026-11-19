/** Original Launch RPCs against the real IPC handlers, dev process and Electron browser. */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createCipheriv, createHash, pbkdf2Sync, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ChromeImportPresence } from "../../shared/chrome-import";
import {
  app,
  BaseWindow,
  BrowserWindow,
  dialog,
  session,
  shell,
  systemPreferences,
  WebContentsView,
} from "electron";
import type { AppContext } from "../../electron/app/app-context";
import {
  BrowserHost,
  type HostView,
} from "../../electron/browser/browser-host";
import { DevServers } from "../../electron/browser/dev-servers";
import { ChromeImport } from "../../electron/browser/chrome-import";
import { requestChromeImportPresence } from "../../electron/browser/chrome-import-presence";
import {
  chromeEpoch,
  chromeKey,
  chromeProfiles,
  readChromeCookies,
} from "../../electron/browser/chrome-cookies";
import { BrowserPartitions } from "../../electron/browser/partitions";
import type { BrowserService } from "../../electron/browser";
import { registerPanelHandlers } from "../../electron/ipc/panels";
import type { NativeHost } from "../../electron/official-ui/native/host";
import { registerLaunch } from "../../electron/official-ui/native/launch";
import { registerPreferences } from "../../electron/official-ui/native/preferences";
import type { AppEvent, Conversation } from "../../shared/types";
import { openPolicy } from "../../shared/client-policy";

const root = process.env.CLAUDEX_LAUNCH_FIXTURE_DIR;
const browserCase = process.env.CLAUDEX_LAUNCH_FIXTURE_CASE;
const touchIdCase = browserCase === "browser-touch-id";
const browserAuth = browserCase === "browser-auth" || touchIdCase;
const browserOnly = browserAuth || browserCase === "browser-settings";
if (!root || fs.readdirSync(root).length)
  throw Error("Use a new empty fixture directory.");
app.setName("Claudex Launch Test");
app.setPath("userData", path.join(root, "electron-profile"));
app.commandLine.appendSwitch("host-resolver-rules", "MAP example.com 127.0.0.1");
app.commandLine.appendSwitch("no-proxy-server");
shell.openExternal = async () => { throw Error("This fixture cannot launch an external browser."); };
app.dock?.hide();

async function freePort() {
  const socket = net.createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address() as net.AddressInfo;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

async function until(check: () => boolean | Promise<boolean>, what: string) {
  const deadline = Date.now() + 8_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error("Timed out waiting for " + what);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

function writeCookieDonor(home: string, key?: Buffer) {
  const root = path.join(home, "Library", "Application Support", "Google", "Chrome");
  const network = path.join(root, "Default", "Network");
  fs.mkdirSync(network, { recursive: true });
  fs.writeFileSync(path.join(root, "Local State"), JSON.stringify({
    profile: { last_used: "Default", info_cache: { Default: { name: "Fixture Chrome" } } },
  }));
  const database = new DatabaseSync(path.join(network, "Cookies"));
  try {
    database.exec(`CREATE TABLE meta (key TEXT, value TEXT);
      INSERT INTO meta VALUES ('version', '24');
      CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB,
        path TEXT, is_secure INT, is_httponly INT, samesite INT, expires_utc INT,
        has_expires INT, last_access_utc INT, top_frame_site_key TEXT NOT NULL DEFAULT '');`);
    const insert = database.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')");
    const now = (chromeEpoch + Date.now() / 1000) * 1e6;
    for (const host of [".example.com", ".example.org"]) {
      let encrypted: Uint8Array = new Uint8Array();
      if (key) {
        const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
        const plaintext = Buffer.concat([
          createHash("sha256").update(host).digest(),
          Buffer.from("synthetic-value"),
        ]);
        encrypted = Buffer.concat([Buffer.from("v10"), cipher.update(plaintext), cipher.final()]);
      }
      insert.run(host, "fixture", key ? "" : "synthetic-value", encrypted, "/", 0, 1, 1, now + 86400e6, 1, now);
    }
  } finally {
    database.close();
  }
}

async function run(
  root: string,
  credential?: { keychain: string; service: string; donorKey: Buffer },
) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(root, "project-")));
  const port = await freePort();
  const aiPort = await freePort();
  const failPort = await freePort();
  const packageJson = path.join(cwd, "package.json");
  const vitePackage = createRequire(path.resolve("package.json")).resolve(
    "vite/package.json",
  );
  const vite = path
    .join(path.dirname(vitePackage), "bin", "vite.js")
    .replaceAll("\\", "/");
  const scripts = {
    dev: `node server.cjs --port ${port}`,
    "preview:fixture": `node "${vite}" --port ${aiPort} --strictPort --host 127.0.0.1`,
  };
  fs.writeFileSync(packageJson, JSON.stringify({ scripts }));
  fs.writeFileSync(
    path.join(cwd, "README.md"),
    `Use npm run preview:fixture to preview the second page on ${aiPort}.`,
  );
  fs.writeFileSync(
    path.join(cwd, "index.html"),
    "<!doctype html><title>Vite fixture</title><main>Vite preview</main>",
  );
  fs.writeFileSync(
    path.join(cwd, "server.cjs"),
    `
    const http = require("node:http");
    setTimeout(() => http.createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end("<title>Fixture " + req.url + "</title><main>Launch fixture</main>");
    }).listen(Number(process.argv[3]), "127.0.0.1", () => console.log("fixture server ready")), 250);
  `,
  );
  fs.writeFileSync(
    path.join(cwd, "fail.cjs"),
    'console.error("fixture startup failure"); process.exit(3);',
  );
  const c: Conversation = {
    id: "launch-fixture",
    title: "Launch fixture",
    mode: "code",
    cwd,
    providerId: "fixture",
    model: "fixture",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [],
  };
  let reply: string | undefined;
  let holdModelReply = false;
  const modelInputs: Record<string, unknown>[] = [];
  const cookieRequests = new Map<string, boolean>();
  const model = http.createServer(async (req, res) => {
    if (req.url?.startsWith("/fixture-cookie-check/")) {
      cookieRequests.set(req.url, req.headers.cookie?.split(/;\s*/).includes("fixture=synthetic-value") === true);
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end("<title>Loopback cookie fixture</title>");
      return;
    }
    const body = [];
    for await (const part of req) body.push(part);
    modelInputs.push(JSON.parse(Buffer.concat(body).toString("utf8")));
    if (holdModelReply) return;
    if (reply === undefined) {
      res.writeHead(503, { "content-type": "application/json" }).end("{}");
      return;
    }
    const event = { type: "response.output_text.delta", delta: reply };
    res
      .writeHead(200, { "content-type": "text/event-stream" })
      .end(`data: ${JSON.stringify(event)}\n\n`);
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const modelUrl = `http://127.0.0.1:${(model.address() as net.AddressInfo).port}`;
  const window = new BrowserWindow({ show: false });
  let fixtureCaller = window;
  const parking = new BaseWindow({ show: false });
  const events = new Set<(event: AppEvent) => void>();
  const push = (event: AppEvent) =>
    events.forEach((listener) => listener(event));
  const servers = new DevServers({
    conversation: (id) => (id === c.id ? { cwd } : undefined),
    unattended: () => false,
    allowed: () => true,
    onEvent: (listener) => {
      events.add(listener);
      return () => {
        events.delete(listener);
      };
    },
    env: { PATH: process.env.PATH },
    shellPath: async () => undefined,
  });
  const sharedPartition = "f104-launch-shared";
  let codePartition = "f104-launch-test";
  const browser = new BrowserHost({
    platform: {
      createView: (partition) =>
        new WebContentsView({
          webPreferences: { partition, sandbox: true, nodeIntegration: false },
        }) as unknown as HostView,
      parking: () =>
        parking as unknown as ReturnType<
          BrowserHost["deps"]["platform"]["parking"]
        >,
    },
    partition: () => codePartition,
    blockedDomains: () => [],
    toolsAvailable: () => true,
    devServers: (id) => {
      const config = servers.launchConfig(id);
      return {
        available: true,
        servers: servers.list(id),
        launchConfigPath: config.path,
        launchConfigError: config.error,
        autoVerify: servers.autoVerify(id),
      };
    },
    push: (state) => push({ type: "browser", state }),
  });
  const offServerChange = servers.onChange((id) => browser.refresh(id));
  const donorHome = path.join(root, "cookie-donor-home");
  writeCookieDonor(donorHome, credential?.donorKey);
  const profiles = await chromeProfiles(donorHome, "darwin");
  assert.equal(profiles.length, 1);
  const [profile] = profiles;
  let consent: ChromeImportPresence = "presence_declined";
  let credentialAvailable = true;
  let externalSites = true;
  const partitions = new BrowserPartitions({
    fromPartition: name => session.fromPartition(name),
    blockedDomains: () => [],
    downloadRefused: () => {},
  });
  const previewJar = partitions.session("f104-launch-test");
  const sharedJar = partitions.session(sharedPartition);
  const publicUrl = "https://preview-fixture.invalid/page?test=1";
  previewJar.protocol.handle("https", (request) => {
    if (request.url !== publicUrl)
      return new Response("fixture URL only", { status: 404 });
    return new Response("<title>Public URL attachment</title>", {
      headers: { "content-type": "text/html" },
    });
  });
  const importer = new ChromeImport({
    profiles: () => chromeProfiles(donorHome, "darwin"),
    touchId: () => touchIdCase && systemPreferences.canPromptTouchID(),
    authorize: async (_profile, lifetime) => {
      if (!touchIdCase) return consent;
      return requestChromeImportPresence(async () => {
        console.log("F075_TOUCH_ID_PROMPT_READY");
        await systemPreferences.promptTouchID("验证 Claudex F075 隔离测试中的合成 Cookie 导入");
        console.log("F075_TOUCH_ID_GRANTED");
        return true;
      }, lifetime);
    },
    read: readChromeCookies,
    key: (profile) => credential
      ? chromeKey({
          ...profile,
          safeStorage: credential.service + (credentialAvailable ? "" : "-missing"),
        }, credential.keychain)
      : Promise.resolve(Buffer.alloc(16)),
    target: async (id) => ({
      partition: id === "shared" ? sharedPartition : "f104-launch-test",
      jar: id === "shared" ? sharedJar : previewJar,
      persistent: false,
    }),
    shared: () => ({ partition: sharedPartition, jar: sharedJar }),
    reload: () => {},
    blocked: () => false,
    indexFile: path.join(root, "fixture-imports.json"),
  });
  const service: BrowserService = {
    host: browser,
    toolsAvailable: () => true,
    policy: () => ({ externalSites }),
    blockedDomains: browser.deps.blockedDomains,
    keepCookies: () => "until-quit",
    openUrl: () => {
      throw Error("Use the fixture's Launch handlers to open pages.");
    },
    attachDevServers: () => {
      throw Error("The fixture already owns its dev servers.");
    },
    devServers: () => servers,
    chromeImport: async () => importer,
    clearBrowsingData: async (id) => {
      assert.equal(id, c.id);
      const partition = browser.activePartition(c.id);
      await importer.clearPartition(partition);
      await partitions.clear(partition);
      browser.reloadAll();
      return partition === sharedPartition;
    },
    clearCoworkBrowserData: async () => {
      await importer.clearPartition(sharedPartition);
      await partitions.clear(sharedPartition);
      return true;
    },
    clearPreviewData: async () => {},
    defaultBrowserName: () => null,
  };
  const ipc = new Map<string, (...args: unknown[]) => unknown>();
  const launch = new Map<string, (...args: unknown[]) => unknown>();
  const activeServerStates: string[] = [];
  let activeServers: {
    status: string;
    startedAt: string;
    previewId: string;
    tabId?: string;
  }[] = [];
  const other: Conversation = {
    ...c,
    id: "other-session",
    providerId: "other-provider",
  };
  const conversations = [other, c];
  const retiring = new Set<() => void>();
  let activation = 1;
  const ctx = {
    account: () => ({ id: "fixture" }),
    sessionIdentity: () => activation,
    get accountActivationIdentity() {
      return activation;
    },
    onAccountDeactivating: (listener: () => void) => {
      retiring.add(listener);
      return () => retiring.delete(listener);
    },
    localLoadConversation: async (id: string) =>
      conversations.find((item) => item.id === id),
    localListConversations: async () => conversations,
    localCall: (method: string, ...args: unknown[]) => {
      const handler = ipc.get(method);
      assert.ok(handler, method);
      return handler(...args);
    },
    onEvent: (listener: (event: AppEvent) => void) => {
      events.add(listener);
      return () => {
        events.delete(listener);
      };
    },
    store: {
      conversations,
      conversation: (id: string) =>
        conversations.find((item) => item.id === id),
      settings: {
        providers: [{ id: c.providerId, model: c.model, models: [] }],
      },
    },
    engine: {
      providerId: c.providerId,
      gatewayEndpoint: () => ({ url: modelUrl, token: "fixture-token" }),
    },
    callerWindow: () => fixtureCaller,
    stateDirectory: () => root,
    settings: () => ctx.store.settings,
    allowedFolder: (folder: string) => assert.equal(folder, cwd),
    policy: () => openPolicy,
    log() {},
  };
  registerPanelHandlers(
    (name, handler) => {
      ipc.set(name, handler);
    },
    ctx as unknown as AppContext,
    async () => ({
      service: () => service,
      saveImage: async () => false,
      chooseHtmlFile: async () => undefined,
      saveFile: async () => false,
      openExternal: async () => {
        throw Error("This test only uses the built-in browser.");
      },
    }),
  );
  const fixtureHost = {
    ctx,
    window,
    on(name: string, handler: (...args: unknown[]) => unknown) {
      launch.set(name, handler);
      return fixtureHost;
    },
    store: () => ({
      get: () => activeServers,
      set: (value: typeof activeServers) => {
        for (const row of value)
          assert.match(row.startedAt, /^\d{4}-\d\d-\d\dT/);
        activeServers = value;
        activeServerStates.push(...value.map((row) => row.status));
      },
    }),
    emit() {},
  } as unknown as NativeHost;
  const preferences = registerPreferences(fixtureHost, {});
  const offLaunch = registerLaunch(fixtureHost, undefined, preferences.autoOpenFiles, preferences.resetChromeImportPrompt);
  const call = <T>(name: string, ...args: unknown[]) => {
    const handler = launch.get("Launch." + name);
    assert.ok(handler, name);
    return Promise.resolve(handler(...args)) as Promise<T>;
  };
  const probeBiometricImport = async (previewId: string) => {
    assert.deepEqual(await call("getChromeImportAvailability"), {
      available: true,
      touchId: true,
    });
    const sites = await call<{ ok: boolean; error?: string; ticket: string }>("listChromeImportSites", previewId);
    assert.equal(sites.ok, true, "Touch ID outcome: " + sites.error);
    const imported = await call<{ ok: boolean; results: { imported: number }[] }>(
      "importChromeLogins", previewId, sites.ticket, ["example.com"], false,
    );
    assert.equal(imported.ok, true);
    assert.equal(imported.results[0].imported, 1);
    const cookieUrl = modelUrl.replace("127.0.0.1", "example.com") + "/fixture-cookie-check/imported";
    await call("setPreviewLinkRouting", previewId, true);
    const cookieTab = await call<string>("openExternalLinkInPreview", previewId, cwd, cookieUrl);
    assert.ok(cookieTab);
    await until(() => cookieRequests.get("/fixture-cookie-check/imported") === true, "the encrypted fixture Cookie in Chromium after real Touch ID");
    assert.equal(await call("clearPreviewBrowsingData", previewId), true);
    assert.equal(await call("navigatePreview", previewId, cookieUrl.replace("/imported", "/cleared"), cookieTab), true);
    await until(() => cookieRequests.get("/fixture-cookie-check/cleared") === false, "Chromium to stop sending the cleared fixture Cookie");
    console.log("F075_TOUCH_ID_IMPORT_AND_CLEAR_PASSED");
  };
  const probeBrowserSettings = async (previewId: string) => {
    if (credential) {
      let response: number | undefined;
      const owner = new AbortController();
      const result = await requestChromeImportPresence(async (signal) => {
        ({ response } = await dialog.showMessageBox(window, {
          signal,
          type: "question",
          message: "Claudex isolated import authorization fixture",
          buttons: ["Continue", "Cancel"],
          defaultId: 1,
          cancelId: 1,
        }));
        return response === 0;
      }, owner.signal, 100);
      assert.equal(result, "presence_timed_out");
      await until(() => response === 1, "the real macOS confirmation to dismiss");
    }
    const setPreference = launch.get("AppPreferences.setPreference")!;
    const prompt = () => {
      const settings = launch.get("AppPreferences.getPreferences")!() as Record<string, unknown>;
      return settings.launchChromeImportPrompt;
    };
    assert.equal(prompt(), "pending");
    await assert.rejects(async () => setPreference("launchChromeImportPrompt", "unknown"));
    await setPreference("launchChromeImportPrompt", "done");
    assert.deepEqual(await call("getChromeImportAvailability"), {
      available: true,
      touchId: false,
    });
    assert.deepEqual(
      (await call<{ id: string }[]>("listChromeImportProfiles")).map(
        (item) => item.id,
      ),
      [profile.id],
    );
    assert.deepEqual(await call("listChromeImportSites", previewId), {
      ok: false,
      error: "presence_declined",
    });
    consent = "presence_timed_out";
    assert.deepEqual(await call("listChromeImportSites", previewId), {
      ok: false,
      error: "presence_timed_out",
    });
    consent = "granted";
    if (credential) {
      const sibling = new BrowserWindow({ show: false });
      try {
        const leased = await call<{ ok: boolean; ticket: string }>("listChromeImportSites", previewId);
        assert.equal(leased.ok, true);
        fixtureCaller = sibling;
        assert.deepEqual(
          await call("importChromeLogins", previewId, leased.ticket, ["example.com"], false),
          { ok: false, error: "expired" },
        );
      } finally {
        fixtureCaller = window;
        sibling.destroy();
      }
      const issued = await call<{ ok: boolean; ticket: string }>(
        "listChromeImportSites",
        previewId,
      );
      assert.equal(issued.ok, true);
      credentialAvailable = false;
      assert.deepEqual(
        await call("importChromeLogins", previewId, issued.ticket, ["example.com"], false),
        { ok: false, error: "keychain_denied" },
      );
      assert.deepEqual(await previewJar.cookies.get({ domain: "example.com" }), []);
      credentialAvailable = true;
    }
    const sites = await call<{
      ok: boolean;
      ticket: string;
      storageIsEphemeral: boolean;
      sites: { suggested: boolean }[];
    }>("listChromeImportSites", previewId);
    assert.equal(sites.ok, true);
    assert.equal(sites.storageIsEphemeral, true);
    assert.deepEqual(
      sites.sites.map((site) => site.suggested),
      [false, false],
    );
    const imported = await call<{
      ok: boolean;
      results: { imported: number }[];
    }>(
      "importChromeLogins",
      previewId,
      sites.ticket,
      ["example.com"],
      false,
    );
    assert.equal(imported.ok, true);
    assert.equal(imported.results[0].imported, 1);
    assert.equal(
      (await previewJar.cookies.get({ domain: "example.com" }))[0].value,
      "synthetic-value",
    );
    assert.deepEqual(
      await call(
        "importChromeLogins",
        previewId,
        sites.ticket,
        ["example.com"],
        false,
      ),
      { ok: false, error: "expired" },
    );
    const listed = await call<{ root: string; importedAt: string }[]>(
      "listImportedChromeLogins",
      previewId,
    );
    assert.equal(listed[0].root, "example.com");
    assert.match(listed[0].importedAt, /^\d{4}-\d\d-\d\dT/);
    const cookieUrl = modelUrl.replace("127.0.0.1", "example.com") + "/fixture-cookie-check/imported";
    await call("setPreviewLinkRouting", previewId, true);
    assert.equal(browser.session(c.id).routePreviewLinks, true);
    assert.equal(await call("openExternalLinkInPreview", previewId, root, cookieUrl), null);
    const cookieTab = await call<string>("openExternalLinkInPreview", previewId, cwd, cookieUrl);
    assert.ok(cookieTab);
    await until(() => cookieRequests.get("/fixture-cookie-check/imported") === true, "the imported cookie in a real browser request");
    assert.equal(await call("openExternalLinkInPreview", previewId, cwd, cookieUrl), cookieTab);
    await call("setPreviewLinkRouting", previewId, false);
    assert.equal(browser.session(c.id).routePreviewLinks, false);
    const shared = await importer.sites("shared");
    assert.equal(shared.ok, true);
    assert.equal(
      (await importer.import("shared", shared.ticket, ["example.org"], false))
        .ok,
      true,
    );
    assert.deepEqual(
      await call("getChromeImportSharedOffer", previewId),
      { offer: false, sites: 0 },
    );
    assert.deepEqual(
      await call("getChromeImportSharedOffer", previewId, true),
      { offer: true, sites: 1, site: "example.org", storageIsEphemeral: true },
    );
    assert.deepEqual(
      await call("acceptChromeImportSharedOffer", previewId, false),
      { ok: true },
    );
    assert.equal(
      (await previewJar.cookies.get({ domain: "example.org" }))[0].value,
      "synthetic-value",
    );
    assert.equal(await call("clearPreviewBrowsingData", previewId), true);
    assert.equal(prompt(), "done");
    const clearedUrl = cookieUrl.replace("/imported", "/cleared");
    assert.equal(await call("navigatePreview", previewId, clearedUrl, cookieTab), true);
    await until(() => cookieRequests.get("/fixture-cookie-check/cleared") === false, "a real browser request without the cleared cookie");
    assert.deepEqual(await call("listImportedChromeLogins", previewId), []);
    assert.deepEqual(
      await call("removeImportedChromeLogins", previewId),
      [],
    );
    assert.deepEqual(await previewJar.cookies.get({}), []);
    assert.equal(
      (await sharedJar.cookies.get({ domain: "example.org" })).length,
      1,
    );
    assert.deepEqual(await call("getCoworkChromeImportAvailability"), {
      available: true,
      touchId: false,
    });
    assert.equal(await call("clearCoworkBrowserData"), true);
    assert.equal((await sharedJar.cookies.get({ domain: "example.org" })).length, 0);
    assert.equal(prompt(), "pending");
    await setPreference("launchChromeImportPrompt", "dismissed");
    assert.equal(await call("clearCoworkBrowserData"), true);
    assert.equal(prompt(), "dismissed");
    const reimport = await importer.sites("shared");
    assert.equal(reimport.ok, true);
    assert.equal((await importer.import("shared", reimport.ticket, ["example.org"], false)).ok, true);
    await setPreference("launchChromeImportPrompt", "done");
    codePartition = sharedPartition;
    browser.repartition();
    assert.equal(browser.activePartition(c.id), sharedPartition);
    assert.equal(await call("clearPreviewBrowsingData", previewId), true);
    assert.equal((await sharedJar.cookies.get({ domain: "example.org" })).length, 0);
    assert.equal(prompt(), "pending");
  };
  try {
    await launch.get("LocalSessions.setFocusedSession")?.("local_" + c.id);
    if (browserOnly) {
      const previewId = `preview-local_${c.id}`;
      assert.ok(await call("openPreviewTab", previewId, cwd));
      await (touchIdCase ? probeBiometricImport(previewId) : probeBrowserSettings(previewId));
      return;
    }
    assert.deepEqual(await call("getConfiguredServices", cwd), []);
    assert.equal(await call("getAutoVerify", cwd), false);
    assert.equal(await call("setAutoVerify", cwd, false), false);
    const [candidate] = await call<
      [
        {
          name: string;
          port: number;
          runtimeExecutable: string;
          runtimeArgs: string[];
        },
      ]
    >("detectServerCandidates", cwd);
    assert.equal(candidate.port, port);
    assert.deepEqual(
      await call("addServerFromCandidate", cwd, {
        ...candidate,
        runtimeExecutable: "node",
      }),
      { ok: false, reason: "runner-not-allowed" },
    );
    assert.deepEqual(
      await call("addServerFromCandidate", cwd, {
        ...candidate,
        name: "vanished",
        runtimeArgs: ["run", "vanished"],
      }),
      { ok: false, reason: "script-not-found" },
    );
    assert.deepEqual(await call("addServerFromCandidate", cwd, candidate), {
      ok: true,
    });
    assert.deepEqual(await call("addServerFromCandidate", cwd, candidate), {
      ok: false,
      reason: "name-exists",
    });
    assert.deepEqual(await call("getConfiguredServices", cwd), [
      { name: candidate.name, port },
    ]);
    assert.equal(await call("getAutoVerify", cwd), true);
    assert.equal(await call("setAutoVerify", cwd, false), true);
    assert.equal(await call("getAutoVerify", cwd), false);
    const started = await call<{
      serverId: string;
      previewId: string;
      tabId: string;
      error?: string;
    }>("startFromConfig", cwd, candidate.name, "local_" + c.id);
    assert.ok(started.serverId, started.error);
    assert.ok(activeServerStates.includes("starting"));
    const launchConfig = path.join(cwd, ".claude", "launch.json");
    fs.renameSync(launchConfig, launchConfig + ".backup");
    assert.deepEqual(await call("getConfiguredServices", cwd), []);
    await until(
      async () =>
        (await call<{ line: string }[]>("getLogs", started.serverId)).some(
          (entry) => entry.line.includes("fixture server ready"),
        ),
      "server logs",
    );
    fs.renameSync(launchConfig + ".backup", launchConfig);
    const tab = () =>
      browser.state(c.id).tabs.find((tab) => tab.id === started.tabId);
    await until(() => tab()?.title === "Fixture /", "the served page");
    await until(
      () =>
        activeServers.some(
          (row) =>
            row.previewId === started.previewId && row.tabId === started.tabId,
        ),
      "the server tab association",
    );
    assert.match(
      (await fetch(`http://127.0.0.1:${port}/`)).headers.get("content-type") ??
        "",
      /text\/html/,
    );
    await call(
      "navigatePreview",
      started.previewId,
      `http://localhost:${port}/second`,
      started.tabId,
    );
    await until(() => tab()?.title === "Fixture /second", "navigation");
    const another = await call<string>(
      "openPreviewTab",
      started.previewId,
      cwd,
    );
    assert.notEqual(another, started.tabId);
    await call("goBack", started.previewId, started.tabId);
    await until(
      () => tab()?.title === "Fixture /",
      "back in the requested tab",
    );
    assert.deepEqual(
      await call("getPreviewNavState", started.previewId, started.tabId),
      {
        canGoBack: false,
        canGoForward: true,
      },
    );
    await call("goForward", started.previewId, started.tabId);
    await until(
      () => tab()?.title === "Fixture /second",
      "forward in the requested tab",
    );
    assert.equal(browser.state(c.id).activeTabId, another);
    reply =
      '```json\n{"candidates":[{"runtimeExecutable":"npm","runtimeArgs":["run","preview:fixture"],"port":' +
      aiPort +
      ',"framework":"vite"}]}\n```';
    const detected = await call<{
      ok: boolean;
      candidates: (typeof candidate)[];
    }>("detectServerCandidatesWithAgent", cwd);
    assert.equal(detected.ok, true);
    assert.equal(detected.candidates[0].name, "preview:fixture");
    assert.match(JSON.stringify(modelInputs[0]), /Use npm run preview:fixture/);
    assert.equal(modelInputs[0].store, false);
    assert.deepEqual(
      await call("addServerFromCandidate", cwd, detected.candidates[0]),
      { ok: true },
    );
    const second = await call<typeof started>(
      "startFromConfig",
      cwd,
      "preview:fixture",
      "local_" + c.id,
    );
    assert.ok(second.serverId, second.error);
    assert.notEqual(second.tabId, started.tabId);
    await until(
      () =>
        browser.state(c.id).tabs.find((tab) => tab.id === second.tabId)
          ?.title === "Vite fixture",
      "the Vite page",
    );
    assert.match(
      await (await fetch(`http://127.0.0.1:${aiPort}/`)).text(),
      /@vite\/client/,
    );
    assert.equal(
      (
        await call<typeof started>(
          "startFromConfig",
          cwd,
          "DEV",
          "local_" + c.id,
        )
      ).tabId,
      started.tabId,
    );
    await until(() => tab()?.loading === false, "the relaunched Node tab");
    assert.equal(tab()?.title, "Fixture /second");
    assert.deepEqual(
      await call("getPreviewNavState", started.previewId, started.tabId),
      { canGoBack: true, canGoForward: false },
    );
    const raw = JSON.parse(fs.readFileSync(launchConfig, "utf8"));
    raw.configurations.push(
      {
        name: "program",
        program: "${workspaceFolder}/server.cjs",
        args: ["--port", String(port)],
        autoPort: true,
      },
      { name: "local-attach", url: `http://localhost:${port}` },
      { name: "public-attach", url: publicUrl },
    );
    fs.writeFileSync(launchConfig, JSON.stringify(raw));
    const localAttach = await call<typeof started>(
      "startFromConfig",
      cwd,
      "local-attach",
      "local_" + c.id,
    );
    assert.equal(localAttach.serverId, started.previewId);
    assert.equal(localAttach.tabId, started.tabId);
    const program = await call<typeof started>(
      "startFromConfig",
      cwd,
      "program",
      "local_" + c.id,
    );
    assert.ok(program.serverId, program.error);
    const assigned = browser
      .state(c.id)
      .devServers.find((server) => server.name === "program")?.port;
    assert.ok(assigned);
    assert.notEqual(assigned, port);
    assert.match(
      await (await fetch(`http://127.0.0.1:${assigned}/`)).text(),
      /Launch fixture/,
    );
    await until(
      () =>
        browser.state(c.id).tabs.find((tab) => tab.id === program.tabId)
          ?.title === "Fixture /",
      "the relocated program page",
    );
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
    await call("stopServer", program.serverId);
    await assert.rejects(fetch(`http://127.0.0.1:${assigned}/`));
    externalSites = false;
    const blockedAttach = await call<typeof started>(
      "startFromConfig",
      cwd,
      "public-attach",
      "local_" + c.id,
    );
    assert.match(blockedAttach.error ?? "", /did not open/);
    externalSites = true;
    const publicAttach = await call<typeof started>(
      "startFromConfig",
      cwd,
      "public-attach",
      "local_" + c.id,
    );
    assert.equal(publicAttach.serverId, started.previewId, publicAttach.error);
    await until(
      () =>
        browser.state(c.id).tabs.find((tab) => tab.id === publicAttach.tabId)
          ?.title === "Public URL attachment",
      "the synthetic public attachment",
    );
    assert.equal(
      browser.state(c.id).tabs.find((tab) => tab.id === publicAttach.tabId)
        ?.url,
      publicUrl,
    );
    assert.equal(await call("stopServer", second.serverId), true);
    await assert.rejects(fetch(`http://127.0.0.1:${aiPort}/`));
    assert.equal(await call("stopServer", started.serverId), true);
    assert.deepEqual(activeServers, []);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
    const configured = fs.readFileSync(launchConfig, "utf8");
    fs.writeFileSync(launchConfig, "{");
    const invalid = await call<{ error: string }>(
      "startFromConfig",
      cwd,
      "dev",
      "local_" + c.id,
    );
    assert.match(invalid.error, /launch\.json/);
    fs.writeFileSync(launchConfig, configured);
    await servers.save(c.id, {
      name: "fail",
      runtimeExecutable: "node",
      runtimeArgs: ["fail.cjs", "--port", String(failPort)],
      port: failPort,
    });
    const failed = await call<{ error: string }>(
      "startFromConfig",
      cwd,
      "fail",
      "local_" + c.id,
    );
    assert.match(failed.error, /fixture startup failure/);
    fs.copyFileSync(path.join(cwd, "server.cjs"), path.join(cwd, "fail.cjs"));
    const retried = await call<typeof started>(
      "startFromConfig",
      cwd,
      "fail",
      "local_" + c.id,
    );
    assert.ok(retried.serverId, retried.error);
    await call("stopServer", retried.serverId);
    reply = undefined;
    assert.deepEqual(await call("detectServerCandidatesWithAgent", cwd), {
      ok: false,
      candidates: [],
      reason: "query-failed",
    });
    reply = "```json\n{\n```";
    assert.deepEqual(await call("detectServerCandidatesWithAgent", cwd), {
      ok: false,
      candidates: [],
      reason: "bad-json",
    });
    fs.writeFileSync(packageJson, "{}");
    assert.deepEqual(await call("detectServerCandidates", cwd), []);
    const html = path.join(cwd, "index.html");
    fs.writeFileSync(html, "<title>Static site</title>");
    reply = '{"candidates":[],"htmlEntry":"index.html"}';
    assert.deepEqual(await call("detectServerCandidatesWithAgent", cwd), {
      ok: true,
      candidates: [],
      htmlEntry: html,
    });
    assert.equal(
      await call("loadHtmlPreview", html, "local_" + c.id, cwd),
      "html-preview-" + c.id,
    );
    await until(
      () => browser.state(c.id).tabs.some((tab) => tab.title === "Static site"),
      "the detected static HTML page",
    );

    await probeBrowserSettings(started.previewId);
    holdModelReply = true;
    const requestCount = modelInputs.length;
    const pending = call("detectServerCandidatesWithAgent", cwd);
    const cancelled = assert.rejects(pending, /account changed/);
    await until(
      () => modelInputs.length > requestCount,
      "the pending detection request",
    );
    for (const retire of retiring) retire();
    activation++;
    await cancelled;
  } finally {
    offLaunch();
    offServerChange();
    browser.dispose();
    await servers.dispose();
    importer.dispose();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    window.destroy();
    parking.destroy();
  }
}

async function runBrowserAuth(root: string) {
  assert.equal(process.platform, "darwin");
  const keychain = path.join(root, "fixture.keychain-db");
  const service = "Claudex F075 synthetic " + randomUUID();
  const password = randomUUID();
  const readKeychains = () => execFileSync("/usr/bin/security", ["list-keychains", "-d", "user"], { timeout: 15_000 });
  const before = readKeychains();
  const security = (...args: string[]) => execFileSync("/usr/bin/security", args, {
    stdio: ["ignore", "ignore", "ignore"], timeout: 15_000,
  });
  security("create-keychain", "-p", password, keychain);
  try {
    assert.ok(readKeychains().equals(before), "The fixture must use an explicit temporary Keychain");
    security("unlock-keychain", "-p", password, keychain);
    security("add-generic-password", "-a", "fixture", "-s", service, "-w", password, "-T", "/usr/bin/security", keychain);
    await run(root, {
      keychain, service,
      donorKey: pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1"),
    });
  } finally {
    security("delete-keychain", keychain);
    assert.ok(readKeychains().equals(before), "The user's Keychain list must be preserved");
  }
}

app
  .whenReady()
  .then(() => browserAuth ? runBrowserAuth(root) : run(root))
  .then(
    () => {
      console.log(
        browserAuth
          ? "Temporary macOS Keychain authorized synthetic encrypted Chrome cookies, and Chromium used the imported cookie."
          : browserOnly
          ? "Guarded link routing, actual synthetic Chrome cookie import, and browser data clearing passed."
          : "Launch detection, start, navigation, stop, retry, guarded link routing and synthetic Chrome import/clear passed.",
      );
      app.exit(0);
    },
    (error) => {
      console.error(error);
      app.exit(1);
    },
  );
