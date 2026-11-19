import { randomUUID } from "node:crypto";
import { nativeImage, session, WebContentsView } from "electron";
import { builtInAttachmentBytes } from "../../../shared/client-policy";

type ImageSize = { width: number; height: number };

const shell = "data:text/html;charset=utf-8," + encodeURIComponent(
  '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'"><title>Image decoder</title>',
);

/** Signatures select a decoder, never establish that an image is valid. */
function fallbackType(data: Buffer): "image/gif" | "image/webp" | "image/bmp" | undefined {
  const signature = data.subarray(0, 6).toString("ascii");
  if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  if (data.subarray(0, 4).toString("ascii") === "RIFF" &&
      data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (data.toString("latin1", 0, 2) === "BM") return "image/bmp";
  return undefined;
}

/** Full bitmap decoding for supported raster uploads, without opening a window.
 * Electron's nativeImage reads PNG/JPEG but not GIF/WebP on every platform.
 * The fallback receives only bytes in a private, network-disabled Chromium context.
 */
export async function attachmentImageSize(data: Buffer): Promise<ImageSize | undefined> {
  if (!data.length || data.length > builtInAttachmentBytes.image) return undefined;
  const image = nativeImage.createFromBuffer(data);
  if (!image.isEmpty()) return image.getSize();
  const type = fallbackType(data);
  if (!type) return undefined;

  const isolated = session.fromPartition(`claudex-image-${randomUUID()}`, { cache: false });
  isolated.setPermissionCheckHandler(() => false);
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.on("will-download", event => event.preventDefault());
  isolated.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: details.url !== shell || details.method !== "GET" }));
  const view = new WebContentsView({ webPreferences: {
    session: isolated, sandbox: true, contextIsolation: true, webSecurity: true,
    nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
    webviewTag: false, devTools: false, allowRunningInsecureContent: false,
  } });
  const contents = view.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  const prevent = (event: Electron.Event) => event.preventDefault();
  contents.on("will-navigate", prevent);
  contents.on("will-frame-navigate", prevent);
  contents.on("will-redirect", prevent);
  contents.on("will-attach-webview", prevent);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fail: () => void = () => {};
  const unavailable = new Promise<never>((_resolve, reject) => {
    fail = () => reject(new Error("Image decoding is unavailable."));
    timer = setTimeout(fail, 10_000);
  });
  contents.once("render-process-gone", fail);
  contents.once("destroyed", fail);
  try {
    const decode = async () => {
      await contents.loadURL(shell);
      // The shell has no application code, preload, credentials, or remote resources.
      // Base64 is data in a JSON string, never source supplied by the upload.
      return contents.executeJavaScript(`(async () => {
        const encoded = atob(${JSON.stringify(data.toString("base64"))});
        const bytes = new Uint8Array(encoded.length);
        for (let i = 0; i < encoded.length; i++) bytes[i] = encoded.charCodeAt(i);
        const bitmap = await createImageBitmap(new Blob([bytes], { type: ${JSON.stringify(type)} }));
        try { return { width: bitmap.width, height: bitmap.height }; }
        finally { bitmap.close(); }
      })()`);
    };
    const result = await Promise.race([decode(), unavailable]);
    if (result && Number.isSafeInteger(result.width) && Number.isSafeInteger(result.height) &&
        result.width > 0 && result.height > 0) return { width: result.width, height: result.height };
    return undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    contents.removeListener("render-process-gone", fail);
    contents.removeListener("destroyed", fail);
    if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
  }
}
