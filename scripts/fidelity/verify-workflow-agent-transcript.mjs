/** Phase-row activation opens the matching child, then returns to the phase table. */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const profile = fs.mkdtempSync(
  path.join(os.tmpdir(), "claudex-workflow-child-"),
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
  try {
    await window.loadURL("http://127.0.0.1:5173/fidelity/workflow-multi.html");
    const before = await window.webContents.executeJavaScript(
      `document.querySelectorAll('.workflow-agent-row:not(:disabled)').length`,
    );
    if (before !== 10) throw Error(`Expected ten child rows: ${before}`);
    await window.webContents.executeJavaScript(
      `document.querySelector('.workflow-agent-row:not(:disabled)').click()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 90));
    const opened = await window.webContents.executeJavaScript(
      `document.querySelector('.agent-transcript-context')?.textContent`,
    );
    if (!opened?.includes("Understand-0"))
      throw Error(`Wrong child transcript: ${opened}`);
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="Back to background tasks"]').click()`,
    );
    const returned = await window.webContents.executeJavaScript(
      `({phases:document.querySelectorAll('.workflow-phase-trigger').length,first:document.querySelector('.workflow-phase-trigger')?.getAttribute('aria-expanded')})`,
    );
    if (returned.phases !== 6 || returned.first !== "true")
      throw Error(`Workflow table did not return: ${JSON.stringify(returned)}`);
    console.log(JSON.stringify({ rows: before, opened, returned }));
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
