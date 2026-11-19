import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { captureExtensionInstallLease } from "../electron/connectors/extension-install-lease";
import { readPickedExtensionArchive } from "../electron/connectors/extension-picked-archive";
import {
  createExtensionInstaller,
} from "../electron/official-ui/native/extension-install-request";
import { unzipSkill } from "../electron/skills/skill-folder";
import { nativeTranslator } from "../electron/app/native-i18n";

function fixture() {
  let destroyed = false,
    now = 10;
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: { url: "http://localhost:1234/settings/extensions" },
  });
  const window = { isDestroyed: () => destroyed, webContents: contents };
  const identity = { accountId: "owner", store: {}, generation: 1, window };
  const lease = captureExtensionInstallLease(
    () => identity,
    () => now,
  );
  return {
    lease,
    identity,
    contents,
    expire() {
      now += 300001;
    },
    destroy() {
      destroyed = true;
    },
  };
}

test("extension lease retires on account/store/generation/window/URL/close/expiry changes", async () => {
  for (const change of [
    "account",
    "store",
    "generation",
    "window",
    "url",
    "closed",
    "expired",
  ]) {
    const f = fixture();
    assert.equal(f.lease.current(), true);
    if (change === "account") f.identity.accountId = "other";
    if (change === "store") f.identity.store = {};
    if (change === "generation") f.identity.generation++;
    if (change === "window") f.identity.window = { ...f.identity.window };
    if (change === "url") f.contents.mainFrame.url += "/other";
    if (change === "closed") f.destroy();
    if (change === "expired") f.expire();
    await assert.rejects(
      f.lease.wait(Promise.resolve("selected")),
      /expired|changed/,
    );
    f.lease.dispose();
    assert.equal(f.contents.listenerCount("did-start-navigation"), 0);
  }
});

test("extension lease rejects navigate-away-and-back, while iframe navigation does not confer authority", () => {
  const f = fixture();
  f.contents.emit("did-start-navigation", {}, "other", false, false);
  assert.equal(f.lease.current(), true);
  f.contents.emit("did-navigate-in-page", {}, f.contents.mainFrame.url, true);
  assert.throws(f.lease.assertCurrent, /changed/);
  f.lease.dispose();
  assert.equal(f.lease.current(), false);
});

test("picked archive reader enforces type, bounds, symlinks and substitution before reading bytes", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "extension-selected-fixture-"),
  );
  const file = path.join(root, "fixture.mcpb"),
    other = path.join(root, "other.mcpb"),
    link = path.join(root, "link.dxt");
  try {
    fs.writeFileSync(file, "inert fixture, not executable");
    fs.writeFileSync(other, "other inert fixture");
    assert.equal(
      readPickedExtensionArchive(file).data.toString(),
      "inert fixture, not executable",
    );
    assert.throws(() =>
      readPickedExtensionArchive(path.join(root, "file.txt")),
    );
    fs.symlinkSync(file, link);
    assert.throws(() => readPickedExtensionArchive(link));
    const originalOpen = fs.openSync,
      originalRead = fs.readSync;
    let reads = 0;
    fs.openSync = ((name: any, ...args: any[]) => {
      if (name === file) {
        fs.unlinkSync(file);
        fs.symlinkSync(other, file);
      }
      return (originalOpen as any)(name, ...args);
    }) as typeof fs.openSync;
    fs.readSync = ((...args: any[]) => {
      reads++;
      return (originalRead as any)(...args);
    }) as typeof fs.readSync;
    try {
      assert.throws(() => readPickedExtensionArchive(file));
      assert.equal(reads, 0);
    } finally {
      fs.openSync = originalOpen;
      fs.readSync = originalRead;
    }
    fs.unlinkSync(file);
    fs.writeFileSync(file, "");
    fs.truncateSync(file, 100 * 1024 * 1024 + 1);
    assert.throws(() => readPickedExtensionArchive(file));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("existing archive validation rejects zip-slip, archive symlinks and oversized uncompressed contents", async () => {
  const limits = { files: 10, bytes: 100, message: "fixture limit" };
  const normal = new JSZip();
  normal.file("manifest.json", "{}");
  assert.equal(
    unzipSkill(await normal.generateAsync({ type: "nodebuffer" }), limits)
      .get("manifest.json")!
      .toString(),
    "{}",
  );
  const slip = new JSZip();
  slip.file("../outside.txt", "inert");
  const slipBytes = await slip.generateAsync({ type: "nodebuffer" });
  assert.throws(() => unzipSkill(slipBytes, limits), /outside/);
  const linked = new JSZip();
  linked.file("link", "outside", { unixPermissions: 0o120777 });
  const linkedBytes = await linked.generateAsync({
    type: "nodebuffer",
    platform: "UNIX",
  });
  assert.throws(() => unzipSkill(linkedBytes, limits), /links/);
  const large = new JSZip();
  large.file("large", "x".repeat(101));
  const largeBytes = await large.generateAsync({ type: "nodebuffer" });
  assert.throws(() => unzipSkill(largeBytes, limits), /fixture limit/);
  assert.throws(() => unzipSkill(Buffer.from("not a zip"), limits));
  // No third-party installation or execution is performed.
});

test("reselection explanation and picker titles use the existing Chinese native catalog", async () => {
  const t = await nativeTranslator("zh-CN");
  assert.equal(
    t(
      "Extension compatibility has not been verified. Check its runtime and platform requirements before installing.",
    ),
    "尚未核验扩展兼容性。安装前请检查其运行时和操作系统要求。",
  );
  assert.equal(
    t("Choose the extension again in the system picker"),
    "请在系统选择器中重新选择扩展",
  );
  assert.equal(
    t("Choose the extension package to install"),
    "选择要安装的扩展包",
  );
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function installerFixture() {
  const f = fixture();
  const calls: unknown[][] = [],
    events: unknown[][] = [];
  let result: unknown = null,
    gate: Promise<void> | undefined;
  const host = {
    caller: f.identity.window,
    ctx: {
      account: () => ({ id: f.identity.accountId }),
      sessionIdentity: () => f.identity.store,
      settings: () => ({ locale: "zh-CN" }),
      withCallerWindow: (window: object, operation: () => unknown) => {
        assert.equal(window, f.identity.window);
        return operation();
      },
      localCall: async (...args: unknown[]) => {
        calls.push(args);
        await gate;
        return result;
      },
    },
    emit: (...args: unknown[]) => {
      events.push(args);
    },
    takeExtensionDrop: (_window: object, file: string) => ({ name: path.basename(file), data: Buffer.from("selected") }),
  };
  const install = createExtensionInstaller(host as never, undefined, (_window, folder) => String(folder));
  return {
    ...f,
    calls,
    events,
    install,
    result(value: unknown) {
      result = value;
    },
    pause(value: Promise<void>) {
      gate = value;
    },
  };
}

test("selected extension archives and folders reach the installer without another picker", async () => {
  const f = installerFixture();
  assert.equal(await f.install("archive", "/selected.mcpb"), null);
  assert.deepEqual(f.calls[0], ["installExtension", { name: "selected.mcpb", data: Buffer.from("selected") }]);
  f.result("installed");
  assert.equal(await f.install("folder", "/selected-folder"), "installed");
  assert.equal(f.calls[1][0], "installUnpackedExtension");
  assert.deepEqual(f.events, [["Extensions", "extensionsChanged"]]);
});

test("duplicate native clicks cannot open parallel pickers; navigation or account switch prevents acknowledgement", async () => {
  for (const change of ["navigation", "account", "store"]) {
    const f = installerFixture(),
      gate = deferred();
    f.pause(gate.promise);
    const pending = f.install("archive", "/fixture.dxt");
    await new Promise((done) => setImmediate(done));
    await assert.rejects(f.install("archive", "/another.dxt"), /already open/);
    if (change === "navigation")
      f.contents.emit("did-navigate-in-page", {}, "same", true);
    if (change === "account") f.identity.accountId = "other";
    if (change === "store") f.identity.store = {};
    gate.resolve();
    await assert.rejects(pending, /changed/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.events.length, 0);
  }
});

test("a picked archive opens the original preview and installs the previewed bytes without another picker", async (t) => {
  const f = fixture();
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "extension-preview-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "preview.mcpb");
  const manifest = {
    name: "fixture",
    version: "1.0.0",
    server: { type: "node", mcp_config: { command: "node" } },
  };
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(manifest));
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  fs.writeFileSync(file, bytes);
  const events: unknown[][] = [];
  const calls: unknown[][] = [];
  let picks = 0;
  const host = {
    caller: f.identity.window,
    ctx: {
      account: () => ({ id: f.identity.accountId }),
      sessionIdentity: () => f.identity.store,
      isCurrent: () => true,
      withCallerWindow: (_window: object, action: () => unknown) => action(),
      localCall: async (...args: unknown[]) => {
        calls.push(args);
        return "fixture";
      },
    },
    emit: (...args: unknown[]) => {
      events.push(args);
    },
    emitTo: (...args: unknown[]) => {
      events.push(args);
    },
  };
  const install = createExtensionInstaller(host as never, async () => {
    picks++;
    return file;
  });
  assert.equal(await install.preview(), null);
  assert.deepEqual(events[0], [
    host.caller,
    "Extensions",
    "previewExtensionInstallation",
    manifest,
    file,
    "local.mcpb..fixture",
    null,
  ]);
  fs.writeFileSync(file, "changed after preview");
  assert.equal(await install.installPreview("local.mcpb..fixture", file), "local.mcpb..fixture");
  assert.equal(picks, 1);
  assert.equal(calls[0][0], "installExtension");
  assert.deepEqual((calls[0][1] as { name: string; data: Buffer }).data, bytes);
  assert.deepEqual(events[1], ["Extensions", "extensionsChanged"]);
  await assert.rejects(install.installPreview("local.mcpb..fixture", file), /Choose/);
});

test("a multi-file drop previews extensions in order and installs the displayed archive", async (t) => {
  const f = fixture();
  f.lease.dispose();
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "extension-multi-preview-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = new Map<string, Buffer>();
  for (const name of ["first", "second"]) {
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify({ name, version: "1.0.0", server: { type: "node", mcp_config: { command: "node" } } }));
    const file = path.join(root, `${name}.mcpb`);
    const data = await zip.generateAsync({ type: "nodebuffer" });
    fs.writeFileSync(file, data);
    files.set(file, data);
  }
  const events: unknown[][] = [];
  const calls: unknown[][] = [];
  const host = {
    caller: f.identity.window,
    ctx: {
      account: () => ({ id: f.identity.accountId }),
      sessionIdentity: () => f.identity.store,
      isCurrent: () => true,
      withCallerWindow: (_window: object, action: () => unknown) => action(),
      localCall: async (...args: unknown[]) => { calls.push(args); return "second"; },
    },
    takeExtensionDrop: (_window: object, file: string) => ({ name: path.basename(file), data: files.get(file)! }),
    emit: () => {},
    emitTo: (...args: unknown[]) => { events.push(args); },
  };
  const install = createExtensionInstaller(host as never, async () => undefined);
  const [first, second] = [...files.keys()];
  await install.preview(first);
  await install.preview(second);
  assert.deepEqual(events.map((event) => event[5]), ["local.mcpb..first", "local.mcpb..second"]);
  assert.equal(await install.installPreview("local.mcpb..second", second), "local.mcpb..second");
  assert.deepEqual((calls[0][1] as { data: Buffer }).data, files.get(second));
});

test("cancelled and failed preview installations refresh state and allow another attempt", async (t) => {
  const f = fixture();
  f.lease.dispose();
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "extension-preview-retry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "preview.mcpb");
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify({
    name: "fixture", version: "1.0.0",
    server: { type: "node", mcp_config: { command: "node" } },
  }));
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
  let attempt = 0;
  let refreshes = 0;
  const host = {
    caller: f.identity.window,
    ctx: {
      account: () => ({ id: f.identity.accountId }),
      sessionIdentity: () => f.identity.store,
      withCallerWindow: (_window: object, action: () => unknown) => action(),
      localCall: async () => {
        attempt++;
        if (attempt === 2) throw Error("install failed");
        return attempt === 1 || attempt === 3 ? null : "fixture";
      },
    },
    emit: (namespace: string, event: string) => {
      if (namespace === "Extensions" && event === "extensionsChanged") {
        refreshes++;
        if (refreshes === 3) throw Error("event delivery failed");
      }
    },
    emitTo() {},
  };
  const install = createExtensionInstaller(host as never, async () => file);
  await install.preview();
  assert.equal(await install.installPreview("local.mcpb..fixture", file), null);
  assert.equal(refreshes, 1);
  await assert.rejects(install.installPreview("local.mcpb..fixture", file), /install failed/);
  assert.equal(refreshes, 2);
  await assert.rejects(install.installPreview("local.mcpb..fixture", file), /event delivery failed/);
  assert.equal(f.contents.listenerCount("did-start-navigation"), 0);
  assert.equal(f.contents.listenerCount("did-navigate-in-page"), 0);
  assert.equal(await install.installPreview("local.mcpb..fixture", file), "local.mcpb..fixture");
  assert.equal(refreshes, 4);
});

test("the original preview cannot be installed after an account activation changes", async (t) => {
  const f = fixture();
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "extension-preview-owner-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "preview.mcpb");
  const zip = new JSZip();
  zip.file(
    "manifest.json",
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      server: { type: "node", mcp_config: { command: "node" } },
    }),
  );
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
  let calls = 0;
  const host = {
    caller: f.identity.window,
    ctx: {
      account: () => ({ id: f.identity.accountId }),
      sessionIdentity: () => f.identity.store,
      isCurrent: () => true,
      withCallerWindow: (_window: object, action: () => unknown) => action(),
      localCall: async () => {
        calls++;
        return "fixture";
      },
    },
    emit() {},
    emitTo() {},
  };
  const install = createExtensionInstaller(host as never, async () => file);
  await install.preview();
  f.identity.store = {};
  await assert.rejects(install.installPreview("local.mcpb..fixture", file));
  assert.equal(calls, 0);
});

test("folder authority can be consumed once and cannot be forged", async () => {
  const { pickedExtensionFolder, takePickedExtensionFolder } = await import("../electron/connectors/extension-picked-folder");
  const selection = pickedExtensionFolder("/selected/folder");
  assert.equal(takePickedExtensionFolder({}), undefined);
  assert.equal(takePickedExtensionFolder(selection), "/selected/folder");
  assert.equal(takePickedExtensionFolder(selection), undefined);
});

test("extension drop capture accepts only trusted native files on settings", async () => {
  const vm = await import("node:vm");
  const source = fs.readFileSync("electron/official-ui/page-shim.cjs", "utf8");
  const code = source.slice(source.indexOf("// Record the native File objects"), source.indexOf("// Keep a notification"));
  let listener!: (event: unknown) => void;
  const sent: unknown[][] = [];
  const window = { top: null as unknown, addEventListener: (_type: string, callback: typeof listener) => { listener = callback; } };
  window.top = window;
  const location = { pathname: "/epitaxy", hash: "#settings/desktop/extensions" };
  vm.runInNewContext(code, { window, location, require: () => ({ ipcRenderer: { sendSync: (...args: unknown[]) => sent.push(args) }, webUtils: { getPathForFile: (file: { nativePath?: string }) => file.nativePath ?? "" } }) });
  listener({ isTrusted: false, dataTransfer: { files: [{ name: "forged.dxt", nativePath: "/forged.dxt" }] } });
  listener({ isTrusted: true, dataTransfer: { files: [{}] } });
  location.pathname = "/task/new";
  listener({ isTrusted: true, dataTransfer: { files: [{ name: "wrong.dxt", nativePath: "/wrong.dxt" }] } });
  location.pathname = "/epitaxy";
  location.hash = "#settings/desktop/general";
  listener({ isTrusted: true, dataTransfer: { files: [{ name: "wrong-route.dxt", nativePath: "/wrong-route.dxt" }] } });
  location.hash = "#settings/desktop/extensions";
  listener({ isTrusted: true, dataTransfer: { files: [{ name: "notes.txt", nativePath: "/notes.txt" }, { name: "selected.dxt", nativePath: "/selected.dxt" }] } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], "claudex:extension-drop");
  assert.deepEqual(Array.from(sent[0][1] as string[]), ["/selected.dxt"]);
});

test("mixed drops read each extension only when it is requested", async (t) => {
  const { extensionDropPaths, takeExtensionDropFile } = await import("../electron/official-ui/native/extension-drop");
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "extension-drop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const valid = Array.from({ length: 13 }, (_, i) => {
    const file = path.join(root, `extension-${i}.mcpb`);
    fs.writeFileSync(file, `extension ${i}`);
    return file;
  });
  const missing = path.join(root, "missing.dxt");
  const oversized = path.join(root, "oversized.dxt");
  fs.writeFileSync(oversized, "");
  fs.truncateSync(oversized, 100 * 1024 * 1024 + 1);
  const originalOpen = fs.openSync;
  const opened: string[] = [];
  fs.openSync = ((file: any, ...args: any[]) => {
    opened.push(String(file));
    return (originalOpen as any)(file, ...args);
  }) as typeof fs.openSync;
  try {
    const selected = extensionDropPaths([path.join(root, "unrelated.txt"), missing, oversized, ...valid]);
    assert.deepEqual(opened, []);
    assert.throws(() => takeExtensionDropFile(selected, missing));
    assert.throws(() => takeExtensionDropFile(selected, oversized));
    assert.equal(takeExtensionDropFile(selected, valid[0]).data.toString(), "extension 0");
    assert.deepEqual(opened, [valid[0]]);
    assert.throws(() => takeExtensionDropFile(selected, valid[0]), /Drop/);
    assert.equal(takeExtensionDropFile(selected, valid[12]).data.toString(), "extension 12");
    assert.deepEqual(opened, [valid[0], valid[12]]);
  } finally {
    fs.openSync = originalOpen;
  }
});
