import { BrowserWindow } from "electron";
import type { ArtifactPreviews } from "./artifact-previews";

export async function captureArtifactScreenshot(
  previews: ArtifactPreviews,
  html: string,
) {
  const url = previews.create(html);
  const window = new BrowserWindow({
    show: false,
    width: 600,
    height: 315,
    useContentSize: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        await window.loadURL(url);
        await window.webContents.executeJavaScript(
          "document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))",
        );
        const image = await window.webContents.capturePage();
        return image.resize({ width: 600, height: 315 }).toDataURL();
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("The request failed.")),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    window.destroy();
    previews.release(url);
  }
}
