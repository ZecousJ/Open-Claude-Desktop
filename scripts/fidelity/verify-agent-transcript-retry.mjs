/** Isolated native read error followed by the child transcript Retry action. */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-agent-retry-"));
app.setPath("userData", root);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 840,
    height: 700,
    show: false,
    backgroundColor: "#151515",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  try {
    await window.loadURL(
      "http://127.0.0.1:5173/fidelity/single-agent.html?fail=once",
    );
    await window.webContents.executeJavaScript(
      `document.querySelector('.single-agent-task-footer button').click()`,
    );
    await wait(90);
    const before = await window.webContents.executeJavaScript(
      `({error:!!document.querySelector('.agent-transcript-error'),retry:document.querySelector('.agent-transcript-error button')?.textContent,context:!!document.querySelector('.agent-transcript-context')})`,
    );
    if (!before.error || before.retry !== "Retry" || before.context)
      throw Error(`Initial read error not visible: ${JSON.stringify(before)}`);
    await window.webContents.executeJavaScript(
      `document.querySelector('.agent-transcript-error button').click()`,
    );
    await wait(90);
    const after = await window.webContents.executeJavaScript(
      `({error:!!document.querySelector('.agent-transcript-error'),context:document.querySelector('.agent-transcript-context')?.textContent,model:document.querySelector('.agent-transcript-model')?.textContent})`,
    );
    if (
      after.error ||
      !after.context?.includes("Synthetic context") ||
      after.model !== "Model Opus 5.5"
    )
      throw Error(
        `Retry did not restore child transcript: ${JSON.stringify(after)}`,
      );
    console.log(JSON.stringify({ before, after }));
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
