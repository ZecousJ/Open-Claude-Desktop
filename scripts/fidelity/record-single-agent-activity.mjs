/** Isolated native recording of hover, held hover, expand and collapse. */
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
  throw Error("Use an output under work/fidelity/recordings");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-agent-row-"));
app.setPath("userData", profile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const area = screen.getPrimaryDisplay().workArea;
  const window = new BrowserWindow({
    width: 746,
    height: 260,
    x: area.x + Math.max(0, Math.floor((area.width - 746) / 2)),
    y: area.y + Math.max(0, Math.floor((area.height - 260) / 2)),
    title: "Claudex single Agent activity fixture",
    backgroundColor: "#151515",
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
    window.show();
    window.focus();
    const helper = path.resolve("work/fidelity/window-evidence");
    const listed = JSON.parse(
      spawnSync(helper, ["list", "--bundle", "com.github.Electron"], {
        encoding: "utf8",
      }).stdout,
    );
    const id = listed.windows.find(
      (row) => row.title === "Claudex single Agent activity fixture",
    )?.id;
    if (!id) throw Error("Fixture window missing");
    const child = spawn(
      helper,
      [
        "record",
        "--bundle",
        "com.github.Electron",
        "--window-id",
        String(id),
        "--crop",
        "0,0,746,234",
        "--duration",
        "9",
        "--scale",
        "2",
        "--output",
        path.resolve(output),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let errors = "";
    child.stderr.on("data", (chunk) => (errors += chunk));
    const done = new Promise((resolve) => child.once("close", resolve));
    const pointer = async (selector, click = false) => {
      const box = await window.webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`,
      );
      const x = Math.round(box.x + Math.min(box.width / 2, 110)),
        y = Math.round(box.y + box.height / 2);
      window.webContents.sendInputEvent({ type: "mouseMove", x, y });
      if (click)
        for (const type of ["mouseDown", "mouseUp"])
          window.webContents.sendInputEvent({
            type,
            x,
            y,
            button: "left",
            clickCount: 1,
          });
    };
    await pause(700);
    await pointer(".single-agent-prior-tool summary");
    await pause(850);
    await pointer(".single-agent-prior-tool summary", true);
    await pause(900);
    await pointer(".single-agent-prior-tool summary", true);
    await pause(500);
    await pointer(".single-agent-event-rows button");
    await pause(950);
    const code = await done;
    if (code !== 0) throw Error(`Recording failed: ${errors.slice(-400)}`);
    console.log(JSON.stringify({ windowId: id, output: path.resolve(output) }));
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
