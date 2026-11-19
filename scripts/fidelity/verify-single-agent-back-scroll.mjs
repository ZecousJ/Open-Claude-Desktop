/** Check that returning from a child transcript restores the task-list position. */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-agent-scroll-"));
app.setPath("userData", root);
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 840,
    height: 650,
    show: false,
    backgroundColor: "#151515",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  try {
    await window.loadURL("http://127.0.0.1:5173/fidelity/single-agent.html");
    const top = await window.webContents.executeJavaScript(
      `(()=>{const list=document.querySelector('.background-tasks-scroll');list.scrollTop=list.scrollHeight;list.dispatchEvent(new Event('scroll',{bubbles:true}));return list.scrollTop})()`,
    );
    if (top < 80) throw Error(`Task fixture did not overflow: ${top}`);
    await window.webContents.executeJavaScript(
      `document.querySelector('.single-agent-task:last-of-type .single-agent-task-footer button')?.click()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 90));
    const opened = await window.webContents.executeJavaScript(
      `!!document.querySelector('.agent-transcript-panel')`,
    );
    if (!opened) throw Error("Child transcript did not open");
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="Back to background tasks"]').click()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 90));
    const restored = await window.webContents.executeJavaScript(
      `document.querySelector('.background-tasks-scroll').scrollTop`,
    );
    if (Math.abs(restored - top) > 2)
      throw Error(`Task list position lost: ${top}→${restored}`);
    console.log(JSON.stringify({ before: top, restored }));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
app.on("quit", () =>
  fs.rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  }),
);
