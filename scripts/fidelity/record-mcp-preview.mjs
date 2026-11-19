/** Local-only native recording of the offline MCP fixture. */
import { app, BrowserWindow, screen } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
const output = process.argv[2];
if (
  !output ||
  !path
    .resolve(output)
    .startsWith(path.resolve("work/fidelity/recordings") + path.sep)
)
  throw Error("Use an unused output path under work/fidelity/recordings");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-mcp-preview-"));
app.setPath("userData", profile);
app.whenReady().then(async () => {
  const area = screen.getPrimaryDisplay().workArea;
  const family = process.env.FIDELITY_TOOL_FAMILY === "1";
  const title = family
    ? "Claudex tool families fixture"
    : "Claudex MCP tool evidence fixture";
  const page = family ? "tool-families" : "mcp";
  const window = new BrowserWindow({
    width: 900,
    height: 560,
    x: area.x + Math.max(0, Math.floor((area.width - 900) / 2)),
    y: area.y + Math.max(0, Math.floor((area.height - 560) / 2)),
    title,
    backgroundColor: "#141414",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  try {
    await window.loadURL(`http://127.0.0.1:5173/fidelity/${page}.html`);
    window.show();
    window.focus();
    const helper = path.resolve("work/fidelity/window-evidence");
    const windows = JSON.parse(
      spawnSync(helper, ["list", "--bundle", "com.github.Electron"], {
        encoding: "utf8",
      }).stdout,
    ).windows;
    const selected = windows.find((row) => row.title === title);
    if (!selected) throw Error("Local MCP fixture window not found");
    const child = spawn(
      helper,
      [
        "record",
        "--bundle",
        "com.github.Electron",
        "--window-id",
        String(selected.id),
        "--crop",
        "0,0,900,550",
        "--duration",
        family ? "11" : "10",
        "--scale",
        "1",
        "--output",
        path.resolve(output),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const done = new Promise((resolve) => child.once("close", resolve));
    if (!family) {
      await new Promise((resolve) => setTimeout(resolve, 6400));
      const click = async (index) => {
        const rect = await window.webContents.executeJavaScript(
          `document.querySelectorAll('.mcp-tool-activity summary')[${index}].getBoundingClientRect().toJSON()`,
        );
        const x = Math.round(rect.x + Math.min(110, rect.width / 2)),
          y = Math.round(rect.y + rect.height / 2);
        window.webContents.sendInputEvent({ type: "mouseMove", x, y });
        window.webContents.sendInputEvent({
          type: "mouseDown",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
        window.webContents.sendInputEvent({
          type: "mouseUp",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
      };
      await click(1);
      await new Promise((resolve) => setTimeout(resolve, 650));
      await click(0);
    }
    const result = await done;
    if (result !== 0)
      throw Error(`Native recorder failed: ${stderr.slice(-500)}`);
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
