import { WebContentsView, type Session } from "electron";
import type { ImportedStorage } from "./chrome-import-storage";

// Never contact the imported origin or run its scripts.
async function storageDocument<Result>(
  jar: Session,
  origin: string,
  allowed: (host: string) => boolean,
  action: (
    send: (method: string, params?: Record<string, unknown>) => Promise<any>,
  ) => Promise<Result>,
) {
  const parsed = new URL(origin);
  if (
    !/^https?:$/.test(parsed.protocol) ||
    parsed.origin !== origin ||
    !allowed(parsed.hostname)
  )
    throw new Error("Storage import no longer allowed");
  const view = new WebContentsView({
    webPreferences: {
      session: jar,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      images: false,
      webgl: false,
    },
  });
  const contents = view.webContents;
  const url = `${origin}/__claudex-import__`;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        await contents.loadURL("about:blank");
        contents.debugger.attach("1.3");
        contents.debugger.on("message", (_event, method, params) => {
          if (method !== "Fetch.requestPaused") return;
          void contents.debugger
            .sendCommand(
              params.resourceType === "Document" && params.request.url === url
                ? "Fetch.fulfillRequest"
                : "Fetch.failRequest",
              params.resourceType === "Document" && params.request.url === url
                ? {
                    requestId: params.requestId,
                    responseCode: 200,
                    responseHeaders: [
                      { name: "Content-Type", value: "text/plain" },
                    ],
                    body: "",
                  }
                : {
                    requestId: params.requestId,
                    errorReason: "BlockedByClient",
                  },
            )
            .catch(() => {});
        });
        await contents.debugger.sendCommand("Network.enable");
        await contents.debugger.sendCommand("Network.setBypassServiceWorker", {
          bypass: true,
        });
        await contents.debugger.sendCommand("Fetch.enable", {
          patterns: [{ urlPattern: "*", requestStage: "Request" }],
        });
        if (!allowed(new URL(origin).hostname))
          throw new Error("Storage import no longer allowed");
        await contents.loadURL(url);
        if (contents.getURL() !== url)
          throw new Error("Storage seed left its origin");
        await contents.debugger.sendCommand("DOMStorage.enable");
        return action(async (method, params = {}) => {
          if (!allowed(new URL(origin).hostname))
            throw new Error("Storage import no longer allowed");
          return contents.debugger.sendCommand(method, {
            storageId: { securityOrigin: origin, isLocalStorage: true },
            ...params,
          });
        });
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Storage seed timed out")),
          15_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    if (!contents.isDestroyed()) {
      contents.stop();
      try {
        contents.debugger.detach();
      } catch {}
      contents.close();
    }
  }
}

export async function seedChromeStorage(
  jar: Session,
  storage: ImportedStorage,
  allowed: (host: string) => boolean,
) {
  const seeded: string[] = [];
  for (const [origin, items] of storage) {
    if (!allowed(new URL(origin).hostname)) continue;
    try {
      await storageDocument(jar, origin, allowed, async (send) => {
        for (const item of items)
          await send("DOMStorage.setDOMStorageItem", item);
      });
      seeded.push(origin);
    } catch {
      await jar
        .clearData({ dataTypes: ["localStorage"], origins: [origin] })
        .catch(() => {});
    }
  }
  if (jar.isPersistent()) jar.flushStorageData();
  return seeded;
}

export async function readChromeJarStorage(
  jar: Session,
  origins: string[],
  allowed: (host: string) => boolean,
): Promise<ImportedStorage> {
  const storage: ImportedStorage = new Map();
  let bytes = 0;
  for (const origin of new Set(origins)) {
    try {
      const result = await storageDocument(jar, origin, allowed, (send) =>
        send("DOMStorage.getDOMStorageItems"),
      );
      const items: { key: string; value: string }[] = [];
      if (!Array.isArray(result.entries) || result.entries.length > 100_000)
        continue;
      for (const entry of result.entries) {
        if (
          !Array.isArray(entry) ||
          typeof entry[0] !== "string" ||
          typeof entry[1] !== "string"
        )
          continue;
        bytes += Buffer.byteLength(entry[0]) + Buffer.byteLength(entry[1]);
        if (bytes > 64 * 1024 * 1024) return storage;
        items.push({ key: entry[0], value: entry[1] });
      }
      storage.set(origin, items);
    } catch {}
  }
  return storage;
}
