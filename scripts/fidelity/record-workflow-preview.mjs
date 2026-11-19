/** Native local recording of the offline single-Agent Workflow fixture. */
import { app, BrowserWindow, screen } from "electron";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const output = process.argv[2];
if (
  !output ||
  !path
    .resolve(output)
    .startsWith(path.resolve("work/fidelity/recordings") + path.sep)
)
  throw Error("Pass an unused work/fidelity/recordings output path");
const profile = fs.mkdtempSync(
  path.join(os.tmpdir(), "claudex-workflow-preview-"),
);
app.setPath("userData", profile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const area = screen.getPrimaryDisplay().workArea;
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    x: area.x + Math.max(0, Math.floor((area.width - 1200) / 2)),
    y: area.y + Math.max(0, Math.floor((area.height - 800) / 2)),
    title: "Claudex Workflow evidence fixture",
    backgroundColor: "#151515",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  try {
    await window.loadURL("http://127.0.0.1:5173/fidelity/workflow.html");
    window.show();
    window.focus();
    const helper = path.resolve("work/fidelity/window-evidence");
    const selected = JSON.parse(
      spawnSync(helper, ["list", "--bundle", "com.github.Electron"], {
        encoding: "utf8",
      }).stdout,
    ).windows.find((row) => row.title === "Claudex Workflow evidence fixture");
    if (!selected) throw Error("Isolated Workflow window missing");
    const child = spawn(
      helper,
      [
        "record",
        "--bundle",
        "com.github.Electron",
        "--window-id",
        String(selected.id),
        "--crop",
        "0,0,1100,770",
        "--duration",
        "9",
        "--scale",
        "2",
        "--output",
        path.resolve(output),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (value) => (stderr += value));
    const done = new Promise((resolve) => child.once("close", resolve));
    await pause(1000);
    const click = async (selector) => {
      const rect = await window.webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`,
      );
      const x = Math.round(rect.x + Math.min(30, rect.width / 2)),
        y = Math.round(rect.y + rect.height / 2);
      for (const type of ["mouseMove", "mouseDown", "mouseUp"])
        window.webContents.sendInputEvent({
          type,
          x,
          y,
          button: "left",
          clickCount: 1,
        });
    };
    await click(".workflow-card");
    await pause(900);
    fs.writeFileSync(
      path.resolve("work/fidelity/workflow-local-open.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    await pause(1200);
    await click(".workflow-phase-trigger");
    await pause(600);
    await click(".workflow-phase-trigger");
    await pause(1000);
    await click("#complete-workflow");
    const result = await done;
    if (result !== 0) throw Error(`Recorder failed: ${stderr.slice(-500)}`);
    console.log(
      JSON.stringify({ windowId: selected.id, output: path.resolve(output) }),
    );
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
