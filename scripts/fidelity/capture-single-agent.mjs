import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-agent-preview-"));
app.setPath("userData", root);
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 321,
    height: 1087,
    show: false,
    backgroundColor: "#1b1b1a",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  try {
    await window.loadURL("http://127.0.0.1:5173/fidelity/single-agent.html");
    await window.webContents.executeJavaScript(
      `document.querySelector('main').style.display='none';document.querySelector('.background-tasks-panel').style.minWidth='307px';document.querySelector('.background-tasks-panel').style.maxWidth='307px';document.querySelector('.background-tasks-panel').style.flexBasis='307px';document.querySelector('.background-tasks-panel').style.marginLeft='7px';document.querySelector('.background-tasks-panel').style.marginRight='7px'`,
    );
    await new Promise((resolve) => setTimeout(resolve, 450));
    console.log(
      await window.webContents.executeJavaScript(
        `({width:innerWidth,body:document.body.getBoundingClientRect().toJSON(),panel:document.querySelector('.background-tasks-panel').getBoundingClientRect().toJSON()})`,
      ),
    );
    const directory = path.resolve("work/fidelity");
    fs.writeFileSync(
      path.join(directory, "single-agent-list-local.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    await window.webContents.executeJavaScript(
      `document.querySelector('.single-agent-task-footer button').click()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 450));
    await window.webContents.executeJavaScript(
      `document.querySelector('.agent-transcript-panel').style.minWidth='305px';document.querySelector('.agent-transcript-panel').style.maxWidth='305px';document.querySelector('.agent-transcript-panel').style.flexBasis='305px';document.querySelector('.agent-transcript-panel').style.marginLeft='7px';document.querySelector('.agent-transcript-panel').style.marginRight='9px'`,
    );
    fs.writeFileSync(
      path.join(directory, "single-agent-transcript-local.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    await window.webContents.executeJavaScript(
      `document.querySelector('.agent-transcript-commands summary').click()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.writeFileSync(
      path.join(directory, "single-agent-commands-open-local.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    await window.loadURL(
      "http://127.0.0.1:5173/fidelity/single-agent.html?theme=light",
    );
    await window.webContents.executeJavaScript(
      `document.querySelector('main').style.display='none';document.querySelector('.background-tasks-panel').style.minWidth='307px';document.querySelector('.background-tasks-panel').style.maxWidth='307px';document.querySelector('.background-tasks-panel').style.flexBasis='307px';document.querySelector('.background-tasks-panel').style.marginLeft='7px';document.querySelector('.background-tasks-panel').style.marginRight='7px'`,
    );
    await new Promise((resolve) => setTimeout(resolve, 160));
    fs.writeFileSync(
      path.join(directory, "single-agent-list-light-local.png"),
      (
        await window.webContents.capturePage({
          x: 0,
          y: 0,
          width: 321,
          height: 600,
        })
      ).toPNG(),
    );
    await window.webContents.executeJavaScript(
      `document.querySelector('.single-agent-task-footer button').click()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 160));
    await window.webContents.executeJavaScript(
      `document.querySelector('.agent-transcript-panel').style.minWidth='305px';document.querySelector('.agent-transcript-panel').style.maxWidth='305px';document.querySelector('.agent-transcript-panel').style.flexBasis='305px';document.querySelector('.agent-transcript-panel').style.marginLeft='7px';document.querySelector('.agent-transcript-panel').style.marginRight='9px'`,
    );
    fs.writeFileSync(
      path.join(directory, "single-agent-transcript-light-local.png"),
      (
        await window.webContents.capturePage({
          x: 0,
          y: 0,
          width: 321,
          height: 600,
        })
      ).toPNG(),
    );
    for (const status of ["failed", "stopped"]) {
      await window.loadURL(
        `http://127.0.0.1:5173/fidelity/single-agent.html?status=${status}`,
      );
      await window.webContents.executeJavaScript(
        `document.querySelector('main').style.display='none'`,
      );
      await window.webContents.executeJavaScript(
        `document.querySelector('.single-agent-task-footer button').click()`,
      );
      await new Promise((resolve) => setTimeout(resolve, 130));
      await window.webContents.executeJavaScript(
        `document.querySelector('.agent-transcript-panel').style.minWidth='305px';document.querySelector('.agent-transcript-panel').style.maxWidth='305px';document.querySelector('.agent-transcript-panel').style.flexBasis='305px';document.querySelector('.agent-transcript-panel').style.marginLeft='7px';document.querySelector('.agent-transcript-panel').style.marginRight='9px'`,
      );
      const seen = await window.webContents.executeJavaScript(
        `document.querySelector('.agent-transcript-terminal')?.textContent`,
      );
      if (seen !== `Agent ${status}`)
        throw Error(`Terminal status missing: ${status} / ${seen}`);
      fs.writeFileSync(
        path.join(directory, `single-agent-transcript-${status}-local.png`),
        (
          await window.webContents.capturePage({
            x: 0,
            y: 0,
            width: 321,
            height: 600,
          })
        ).toPNG(),
      );
    }
    console.log(
      "Captured dark/light and terminal single Agent transcript states in isolated native preview.",
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
