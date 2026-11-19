/** Same-size static panel capture; fixture text is synthetic and not reference content. */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-multi-static-"));
app.setPath("userData", root);
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 519,
    height: 1091,
    show: false,
    backgroundColor: "#151515",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  try {
    await window.loadURL("http://127.0.0.1:5173/fidelity/workflow-multi.html");
    const bounds = await window.webContents.executeJavaScript(
      `(()=>{const panel=document.querySelector('.background-tasks-panel');panel.style.flex='0 0 507px';panel.style.minWidth='507px';panel.style.maxWidth='507px';panel.style.marginLeft='7px';panel.style.marginRight='5px';return panel.getBoundingClientRect().toJSON()})()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 140));
    const file = path.resolve("work/fidelity/workflow-multi-static-local.png");
    fs.writeFileSync(
      file,
      (
        await window.webContents.capturePage({
          x: 0,
          y: 0,
          width: 519,
          height: 1059,
        })
      ).toPNG(),
    );
    console.log(JSON.stringify({ file, bounds }));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
app.on("quit", () => fs.rmSync(root, { recursive: true, force: true }));
