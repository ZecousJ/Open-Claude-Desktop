/** Window recording of synthetic single-Agent list -> transcript -> list. */
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
  throw Error("Pass an output inside work/fidelity/recordings");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-agent-motion-"));
app.setPath("userData", profile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay().workArea;
  const window = new BrowserWindow({
    width: 840,
    height: 800,
    x: display.x + Math.max(0, Math.floor((display.width - 840) / 2)),
    y: display.y + Math.max(0, Math.floor((display.height - 800) / 2)),
    title: "Claudex single Agent motion fixture",
    backgroundColor: "#1b1b1a",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  try {
    await window.loadURL("http://127.0.0.1:5173/fidelity/single-agent.html");
    window.show();
    window.focus();
    const helper = path.resolve("work/fidelity/window-evidence");
    const selected = JSON.parse(
      spawnSync(helper, ["list", "--bundle", "com.github.Electron"], {
        encoding: "utf8",
      }).stdout,
    ).windows.find(
      (row) => row.title === "Claudex single Agent motion fixture",
    );
    if (!selected) throw Error("Preview window missing");
    const child = spawn(
      helper,
      [
        "record",
        "--bundle",
        "com.github.Electron",
        "--window-id",
        String(selected.id),
        "--crop",
        "0,0,840,780",
        "--duration",
        "8",
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
    const click = async (selector) => {
      const rect = await window.webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`,
      );
      const x = Math.round(rect.x + rect.width / 2),
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
    await pause(900);
    await click(".single-agent-task-footer button");
    await pause(1800);
    await click('[aria-label="Back to background tasks"]');
    await pause(1200);
    await click(".single-agent-task-footer button");
    const code = await done;
    if (code !== 0) throw Error(`Recording failed: ${stderr.slice(-500)}`);
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
