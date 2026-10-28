import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { useElectronShim } from "../runner/runner-core-support.test.ts";
import type { AppContext } from "../../electron/app/app-context";
import { OfficeAddinBridge } from "../../electron/connectors/office-addin";
import { guardContents } from "../../electron/browser/navigation-guard";
import { previewLinkLabel } from "../../shared/preview-link-label";
import { officeInstallation } from "../../electron/connectors/office-addin-installation";
import { X509Certificate } from "node:crypto";

useElectronShim();
const { redactSupportLog, supportLogLines, registerSupportBundleHandlers } =
  await import("../../electron/support/support-bundle");
const {
  registerEditCommandHandlers,
  routeEditCommand,
  contextMenuOwnsHistory,
} = await import("../../electron/app/edit-commands");
const { PreviewLinkRouter } =
  await import("../../electron/artifacts/preview-link-routing");

test("support exports mask credentials/home and collect bounded warnings, not arbitrary files or symlinks", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "claudex-support-"),
  );
  try {
    await fs.writeFile(
      path.join(directory, "app.log"),
      "INFO harmless\nWARN token=private\nERROR Bearer secret\n",
    );
    await fs.writeFile(
      path.join(directory, "secret.json"),
      "ERROR private profile",
    );
    await fs.symlink(
      path.join(directory, "secret.json"),
      path.join(directory, "linked.log"),
    );
    assert.deepEqual(await supportLogLines(directory), [
      "WARN token=<redacted>",
      "ERROR Bearer <redacted>",
    ]);
    assert.equal(
      redactSupportLog(
        "ERROR /private/home/file apiKey=abc sk-secret",
        "/private/home",
      ),
      "ERROR <home>/file apiKey=<redacted> <redacted>",
    );
    await fs.writeFile(
      path.join(directory, "huge.log"),
      "ERROR ignored\n" + "x".repeat(300_000) + "\nWARN recent\n",
    );
    const lines = await supportLogLines(directory);
    assert.ok(lines.includes("WARN recent"));
    assert.ok(!lines.includes("ERROR ignored"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("support archives can be downloaded on web and are invalidated on cancel/account switch", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "claudex-support-profile-"),
  );
  const handlers = new Map<string, (...args: any[]) => any>();
  let deactivate = () => {};
  try {
    registerSupportBundleHandlers(
      (name, handler) => handlers.set(name, handler),
      {
        appVersion: "1.2.3",
        store: { root },
        onAccountDeactivating: (callback: () => void) => {
          deactivate = callback;
        },
      } as unknown as AppContext,
    );
    const preview = await handlers.get("createSupportBundle")!({});
    assert.ok(preview.sizeBytes > 0);
    const exported = await handlers.get("exportSupportBundle")!(
      preview.referenceId,
    );
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(Buffer.from(exported.base64, "base64"));
    assert.deepEqual(Object.keys(zip.files).sort(), [
      "logs.txt",
      "manifest.json",
    ]);
    assert.equal(
      JSON.parse(await zip.file("manifest.json")!.async("string")).system
        .appVersion,
      "1.2.3",
    );
    await assert.rejects(
      handlers.get("captureFeedbackScreenshot")!(),
      /No active window/,
    );
    await assert.rejects(
      handlers.get("createSupportBundle")!({
        screenshotToken: crypto.randomUUID(),
      }),
      /expired/,
    );
    deactivate();
    await assert.rejects(
      handlers.get("exportSupportBundle")!(preview.referenceId),
      /expired/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("claimed edit commands route to the document, fall back natively, and release on navigation", () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const listeners = new Map<string, () => void>();
  const commands: string[] = [];
  const frame = {};
  const contents = {
    focusedFrame: frame,
    mainFrame: frame,
    isDestroyed: () => false,
    on: (event: string, callback: () => void) => listeners.set(event, callback),
    once: (event: string, callback: () => void) =>
      listeners.set(event, callback),
    send: (_channel: string, event: { command: string }) =>
      commands.push(`renderer:${event.command}`),
    undo: () => commands.push("native:undo"),
    redo: () => commands.push("native:redo"),
  };
  registerEditCommandHandlers((name, handler) => handlers.set(name, handler), {
    window: { webContents: contents },
  } as unknown as AppContext);
  handlers.get("claimEditCommands")!();
  routeEditCommand("undo", contents as any);
  handlers.get("editCommandUnclaimed")!("undo");
  handlers.get("reportContextMenuEditor")!(true);
  assert.equal(contextMenuOwnsHistory(contents as any), true);
  assert.equal(contextMenuOwnsHistory(contents as any), false);
  listeners.get("did-navigate")!();
  routeEditCommand("redo", contents as any);
  assert.deepEqual(commands, ["renderer:undo", "native:undo", "native:redo"]);
});

test("preview requests use native confirmation before readiness, are window scoped and allow one confirmation", async () => {
  const events: any[] = [];
  const window = { webContents: { id: 12 } };
  const native: string[] = [];
  const router = new PreviewLinkRouter(
    {
      appWindows: {
        focused: () => window,
        main: () => window,
        send: (_window: unknown, event: unknown) => events.push(event),
      },
      policy: () => ({ externalLinks: true, trustedLinkDomains: [] }),
    } as unknown as AppContext,
    async (url) => {
      native.push(url);
      return false;
    },
  );
  try {
    await router.request("https://example.com");
    assert.equal(events.length, 0);
    assert.deepEqual(native, ["https://example.com"]);
    router.setReady(12, true);
    router.request("https://example.com");
    router.request("https://example.org");
    assert.equal(events.length, 1);
    await router.resolve(99, events[0].requestId, false);
    router.request("https://example.org");
    assert.equal(events.length, 1);
    await router.resolve(12, events[0].requestId, false);
    router.request("https://example.org");
    assert.equal(events.length, 2);
    router.setReady(12, false);
    await router.request("https://example.net");
    assert.equal(events.length, 2);
  } finally {
    router.dispose();
  }
});

test("Office handoffs have a bounded queue and support cancellation without exposing a listener", () => {
  const bridge = new OfficeAddinBridge(() => {});
  const input = {
    sessionId: "session",
    filePath: "/chosen/book.xlsx",
    title: "Budget",
    messages: [{ role: "user", text: "Review" }],
    strippedToolCalls: 0,
    omittedByRenderer: 0,
  };
  const first = bridge.queue(input);
  assert.equal(first.queued, true);
  for (let index = 1; index < 16; index++)
    assert.equal(bridge.queue(input).queued, true);
  assert.equal(bridge.queue(input).queued, false);
  bridge.cancel(first.handoffId!);
  assert.equal(bridge.queue(input).queued, true);
  assert.deepEqual(bridge.connectedFiles(), []);
  assert.equal(bridge.focus("unconnected"), false);
  assert.throws(() => bridge.manifest(), /not running/);
  bridge.dispose();
});

test("preview confirmation only intercepts navigations and popups, not redirects or blocked hosts", () => {
  const listeners = new Map<string, (event: any) => void>();
  let popup: (details: any) => unknown;
  const routed: string[] = [];
  const refused: string[] = [];
  const contents = {
    on: (event: string, listener: (event: any) => void) =>
      listeners.set(event, listener),
    setWindowOpenHandler: (handler: (details: any) => unknown) => {
      popup = handler;
    },
  };
  guardContents(
    contents as any,
    () => ({ fileRoots: [], blockedDomains: ["blocked.example"] }),
    {
      routeLink: (url) => {
        routed.push(url);
        return true;
      },
      refused: (url) => {
        refused.push(url);
      },
      openTab: () => assert.fail("routed popup must not create a tab"),
    },
  );
  let prevented = 0;
  const event = (url: string) => ({
    url,
    isMainFrame: true,
    preventDefault: () => {
      prevented++;
    },
  });
  listeners.get("will-navigate")!(event("https://example.com"));
  listeners.get("will-redirect")!(event("https://example.org"));
  listeners.get("will-navigate")!(event("https://blocked.example"));
  popup!({ url: "https://example.net", disposition: "new-window" });
  assert.deepEqual(routed, ["https://example.com", "https://example.net"]);
  assert.deepEqual(refused, ["https://blocked.example"]);
  assert.equal(prevented, 2);
});

test("preview URL labels preserve both ends and soft-wrap long destinations", () => {
  const url = `https://example.com/${"a".repeat(400)}?tail=true`;
  const label = previewLinkLabel(url, false);
  assert.ok(label.startsWith("https://example.com/"));
  assert.ok(label.endsWith("?tail=true"));
  assert.ok(label.includes("…"));
  assert.equal(label.length, "https://example.com".length + 161);
  assert.equal(previewLinkLabel(url).replaceAll("\u200B", ""), label);
  assert.equal(previewLinkLabel("invalid"), "invalid");
});

test("Office installation persists a private capability and localhost TLS certificate without changing system trust", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "claudex-office-install-"),
  );
  try {
    const installation = await officeInstallation(directory);
    const certificate = new X509Certificate(installation.cert);
    assert.ok(certificate.checkIP("127.0.0.1"));
    assert.equal(certificate.checkHost("localhost"), "localhost");
    assert.equal(installation.token.length, 64);
    assert.equal(
      (await fs.stat(path.join(directory, "office-addin", "localhost.key")))
        .mode & 0o777,
      0o600,
    );
    await installation.save({ port: 12345, token: installation.token });
    const restored = await officeInstallation(directory);
    assert.equal(restored.port, 12345);
    assert.equal(restored.token, installation.token);
    assert.equal(restored.cert, installation.cert);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
