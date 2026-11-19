import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { referenceFonts } from "../../electron/app/reference-fonts.ts";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-agent-activity-"));
app.setPath("userData", root);
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 746,
    height: 166,
    show: false,
    backgroundColor: "#1b1b1a",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  try {
    await window.loadURL(
      "http://127.0.0.1:5173/fidelity/single-agent-activity.html",
    );
    const font = referenceFonts().find(
      (value) =>
        value.family === "Claudex Reference Sans" && value.style === "normal",
    );
    if (font) {
      const encoded = Buffer.from(font.data).toString("base64");
      await window.webContents.executeJavaScript(
        `(async()=>{const binary=atob(${JSON.stringify(encoded)});const bytes=Uint8Array.from(binary,character=>character.charCodeAt(0));const face=new FontFace('Claudex Reference Sans',bytes.buffer,{weight:'300 800'});await face.load();document.fonts.add(face);document.documentElement.dataset.referenceFonts='true';return document.fonts.check('14px Claudex Reference Sans')})()`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
    const folder = path.resolve("work/fidelity");
    fs.writeFileSync(
      path.join(folder, "single-agent-activity-local.png"),
      (
        await window.webContents.capturePage({
          x: 0,
          y: 0,
          width: 746,
          height: 117,
        })
      ).toPNG(),
    );
    await window.webContents.executeJavaScript(
      `document.querySelector('.single-agent-prior-tool summary').click()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 90));
    fs.writeFileSync(
      path.join(folder, "single-agent-prior-tool-open-local.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    console.log(
      "Captured closed and expanded synthetic single-Agent tool activity.",
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
app.on("quit", () => fs.rmSync(root, { recursive: true, force: true }));
