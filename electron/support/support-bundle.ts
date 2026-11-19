import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, dialog, shell } from "electron";
import { z } from "zod";
import { nativeTranslator } from "../app/native-i18n";
import { preference } from "../../shared/settings-extras";
import type { AppContext, IpcHandle } from "../app/app-context";
import type { BrowserWindow } from "electron";
import type {
  SupportBundlePreview,
  SupportSystemInfo,
} from "../../shared/support-bundle-api";

const maxLogBytes = 256 * 1024;
const maxBundleLogBytes = 2 * 1024 * 1024;
const expiresAfter = 5 * 60_000;

export function redactSupportLog(value: string, home = os.homedir()) {
  return value
    .split(home)
    .join("<home>")
    .replace(/\b(Bearer\s+)[^\s"']+/gi, "$1<redacted>")
    .replace(
      /((?:api[_-]?key|token|password|secret|authorization|cookie)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      "$1<redacted>",
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<redacted>")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "<redacted>");
}

export async function supportLogLines(directory: string) {
  const lines: string[] = [];
  let bytes = 0;
  const entries = await fs
    .readdir(directory, { withFileTypes: true })
    .catch(() => []);
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (
      !entry.isFile() ||
      !/\.(?:log|txt)$/i.test(entry.name) ||
      bytes >= maxBundleLogBytes
    )
      continue;
    const file = await fs
      .open(
        path.join(directory, entry.name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      )
      .catch(() => undefined);
    if (!file) continue;
    try {
      const stat = await file.stat();
      if (!stat.isFile()) continue;
      const size = Math.min(stat.size, maxLogBytes, maxBundleLogBytes - bytes);
      const buffer = Buffer.alloc(size);
      const read = await file.read(
        buffer,
        0,
        size,
        Math.max(0, stat.size - size),
      );
      bytes += read.bytesRead;
      const text = buffer.subarray(0, read.bytesRead).toString("utf8");
      const complete =
        stat.size > size ? text.slice(text.indexOf("\n") + 1) : text;
      lines.push(
        ...complete
          .split(/\r?\n/)
          .filter((line) => /\b(?:warn(?:ing)?|error|fatal)\b/i.test(line))
          .map((line) => redactSupportLog(line)),
      );
    } finally {
      await file.close();
    }
  }
  return lines;
}

interface SupportArchive {
  preview: SupportBundlePreview;
  zip: Buffer;
}

function supportSystemInfo(appVersion: string): SupportSystemInfo {
  return {
    appVersion,
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
  };
}

export async function buildSupportArchive({
  appVersion,
  logDirectory,
  screenshot,
}: {
  appVersion: string;
  logDirectory: string;
  screenshot?: Buffer;
}): Promise<SupportArchive> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const logs = await supportLogLines(logDirectory);
  const manifest = {
    bundleId: randomUUID(),
    generatedAt: new Date().toISOString(),
    system: supportSystemInfo(appVersion),
    includedScreenshot: !!screenshot,
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  zip.file("logs.txt", logs.join("\n"));
  if (screenshot) zip.file("screenshot.png", screenshot);
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
  return {
    zip: bytes,
    preview: {
      referenceId: manifest.bundleId,
      sizeBytes: bytes.length,
      previewLines: [JSON.stringify(manifest), ...logs],
    },
  };
}

function supportArchiveFilename(id: string) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 13);
  return `claudex-diagnostic-${id.slice(0, 8)}-${stamp}.zip`;
}

export async function saveSupportArchive({
  window,
  archive,
  locale,
  current,
}: {
  window: BrowserWindow;
  archive: SupportArchive;
  locale: string;
  current: () => boolean;
}) {
  const translate = await nativeTranslator(locale);
  if (!current()) return;
  const result = await dialog.showSaveDialog(window, {
    defaultPath: path.join(
      app.getPath("downloads"),
      supportArchiveFilename(archive.preview.referenceId),
    ),
    filters: [{ name: translate("Zip archive"), extensions: ["zip"] }],
  });
  if (!current() || result.canceled || !result.filePath) return;
  await fs.writeFile(result.filePath, archive.zip, { mode: 0o600 });
  return result.filePath;
}

// Explicit, local export is separate from automatic coded diagnostics. Screenshots
// are opaque, window-scoped, expiring tokens (desktop 2.37337.1, index.chunk-BWk6pVUt.js).
export function registerSupportBundleHandlers(
  handle: IpcHandle,
  ctx: AppContext,
) {
  const states = new Map<
    number | undefined,
    {
      screenshot?: { token: string; png: Buffer; expiresAt: number };
      bundle?: {
        archive: SupportArchive;
        expiresAt: number;
        savedPath?: string;
      };
    }
  >();
  const state = () => {
    const key = ctx.window?.webContents.id;
    let value = states.get(key);
    if (!value) {
      value = {};
      states.set(key, value);
      ctx.window?.once("closed", () => states.delete(key));
    }
    if (value.screenshot && value.screenshot.expiresAt <= Date.now())
      delete value.screenshot;
    if (value.bundle && value.bundle.expiresAt <= Date.now())
      delete value.bundle;
    return value;
  };
  ctx.onAccountDeactivating(() => states.clear());
  handle("getSupportSystemInfo", () => supportSystemInfo(ctx.appVersion));
  handle("captureFeedbackScreenshot", async () => {
    const contents = ctx.window?.webContents;
    if (!contents || contents.isDestroyed())
      throw new Error("No active window to capture.");
    const target = state();
    const png = (await contents.capturePage()).toPNG();
    if (png.length > 50 * 1024 * 1024) throw new Error("Screenshot too large");
    const token = randomUUID();
    target.screenshot = { token, png, expiresAt: Date.now() + expiresAfter };
    return { token, sizeBytes: png.length };
  });
  handle("createSupportBundle", async (raw: unknown) => {
    const input = z
      .object({ screenshotToken: z.string().uuid().optional() })
      .strict()
      .parse(raw);
    const target = state();
    const screenshot = input.screenshotToken ? target.screenshot : undefined;
    if (input.screenshotToken && screenshot?.token !== input.screenshotToken)
      throw new Error("Screenshot expired. Capture it again.");
    const key = ctx.window?.webContents.id;
    const archive = await buildSupportArchive({
      appVersion: ctx.appVersion,
      logDirectory: ctx.window
        ? app.getPath("logs")
        : path.join(ctx.store.root, "logs"),
      screenshot: screenshot?.png,
    });
    if (states.get(key) !== target) throw new Error("Report cancelled.");
    target.bundle = { archive, expiresAt: Date.now() + expiresAfter };
    delete target.screenshot;
    return archive.preview;
  });
  handle("exportSupportBundle", async (raw: unknown) => {
    const id = z.string().uuid().parse(raw);
    const target = state();
    const bundle = target.bundle;
    if (!bundle || bundle.archive.preview.referenceId !== id)
      throw new Error("Report expired. Generate it again.");
    const window = ctx.window;
    if (!window)
      return {
        filename: supportArchiveFilename(id),
        base64: bundle.archive.zip.toString("base64"),
      };
    const key = window.webContents.id;
    const savedPath = await saveSupportArchive({
      window,
      archive: bundle.archive,
      locale: preference(ctx.store.settings, "locale"),
      current: () => states.get(key)?.bundle === bundle,
    });
    if (!savedPath) return {};
    bundle.savedPath = savedPath;
    return { savedPath };
  });
  handle("revealSupportBundle", (raw: unknown) => {
    const id = z.string().uuid().parse(raw);
    const bundle = state().bundle;
    if (bundle?.archive.preview.referenceId === id && bundle.savedPath)
      shell.showItemInFolder(bundle.savedPath);
  });
  handle("discardSupportBundle", () =>
    states.delete(ctx.window?.webContents.id),
  );
}
