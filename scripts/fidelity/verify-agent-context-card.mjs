/** Native responsive context card: measure clipping instead of character count. */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const profile = fs.mkdtempSync(
  path.join(os.tmpdir(), "claudex-agent-context-"),
);
app.setPath("userData", profile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1100,
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
      `(()=>{const card=document.querySelector('.agent-transcript-context');return {button:card?.querySelector('button')?.textContent,expanded:card?.querySelector('button')?.getAttribute('aria-expanded'),height:card?.firstElementChild?.scrollHeight,width:card?.getBoundingClientRect().width}})()`,
    );
  try {
    await window.loadURL(
      "http://127.0.0.1:5173/fidelity/single-agent.html?context=adaptive",
    );
    await window.webContents.executeJavaScript(
      `document.querySelector('.single-agent-task-footer button').click()`,
    );
    await delay(100);
    const wide = await read();
    await window.webContents.executeJavaScript(
      `document.querySelector('.agent-transcript-panel').style.flexBasis='300px'`,
    );
    await delay(80);
    const narrow = await read();
    if (wide.button || narrow.button !== "Show more" || narrow.height <= 253)
      throw Error(
        `Responsive clipping mismatch: ${JSON.stringify({ wide, narrow })}`,
      );
    await window.webContents.executeJavaScript(
      `document.querySelector('.agent-transcript-context button').click()`,
    );
    const opened = await read();
    if (opened.button !== "Show less" || opened.expanded !== "true")
      throw Error("Show more did not expand");
    await window.webContents.executeJavaScript(
      `document.querySelector('.agent-transcript-context button').click()`,
    );
    const closed = await read();
    if (closed.button !== "Show more" || closed.expanded !== "false")
      throw Error("Show less did not collapse");
    console.log(JSON.stringify({ wide, narrow, opened, closed }));
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
