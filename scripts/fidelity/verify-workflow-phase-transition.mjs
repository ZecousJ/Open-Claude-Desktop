/** Native fixture checks queued → running disclosure without overriding a manual collapse. */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const profile = fs.mkdtempSync(
  path.join(os.tmpdir(), "claudex-workflow-phases-"),
);
app.setPath("userData", profile);
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    backgroundColor: "#151515",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const read = () =>
    window.webContents.executeJavaScript(
      `[...document.querySelectorAll('.workflow-phase-trigger')].map(row=>({name:row.querySelector('span')?.textContent,open:row.getAttribute('aria-expanded')}))`,
    );
  try {
    await window.loadURL("http://127.0.0.1:5173/fidelity/workflow.html");
    await window.webContents.executeJavaScript(
      `document.querySelector('.workflow-card').click()`,
    );
    const queued = await read();
    if (
      JSON.stringify(queued) !==
      JSON.stringify([
        { name: "Review", open: "true" },
        { name: "Verify", open: "false" },
      ])
    )
      throw Error(`Unexpected queued phases: ${JSON.stringify(queued)}`);
    await window.webContents.executeJavaScript(
      `document.querySelector('#advance-workflow').click()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    const running = await read();
    if (running[1]?.open !== "true")
      throw Error(
        `Verify did not open when running: ${JSON.stringify(running)}`,
      );
    await window.webContents.executeJavaScript(
      `document.querySelectorAll('.workflow-phase-trigger')[1].click()`,
    );
    await window.webContents.executeJavaScript(
      `document.querySelector('#update-workflow').click()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    const updated = await read();
    if (updated[1]?.open !== "false")
      throw Error(`Manual collapse was overridden: ${JSON.stringify(updated)}`);
    console.log(JSON.stringify({ queued, running, updated }));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
app.on("quit", () =>
  fs.rmSync(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  }),
);
