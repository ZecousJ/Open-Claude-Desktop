const { app, BrowserWindow, Menu, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.dirname(process.execPath);
const config = JSON.parse(fs.readFileSync(path.join(root, "smoke.json")));
const profile = path.join(root, "profile");
process.env.CLAUDEX_DATA_DIR = profile;
process.env.CLAUDEX_DISABLE_STEALTH_UPDATES = "1";
app.setPath("userData", profile);
app.setPath("sessionData", profile);
app.setAppLogsPath(path.join(profile, "logs"));
const version = app.getVersion();
const source = version === config.target ? "candidate.asar" : "baseline.asar";
const record = (event, extra = {}) =>
  fs.appendFileSync(
    path.join(root, "events.jsonl"),
    JSON.stringify({
      event,
      version,
      pid: process.pid,
      at: Date.now(),
      ...extra,
    }) + "\n",
  );
record("launch");
const systemRoot = process.env.SystemRoot;
let phase = "waiting";
const readyWindow = () =>
  BrowserWindow.getAllWindows().find(
    (w) =>
      !w.isDestroyed() &&
      w.isVisible() &&
      !w.webContents.isLoading() &&
      w.webContents.getURL() !== "",
  );
let holdExit = true;
app.on("will-quit", (event) => {
  if (version !== config.target && phase === "success" && holdExit) {
    holdExit = false;
    event.preventDefault();
    setTimeout(() => app.quit(), 2000);
  }
});
const showError = dialog.showErrorBox.bind(dialog);
dialog.showErrorBox = (title, message) => {
  if (phase === "failure" && title === "Claudex couldn't restart to update") {
    process.env.SystemRoot = systemRoot;
    phase = "retry";
    record("handoff-failed", { title, message });
    return;
  }
  record("unexpected-error", { title, message });
  showError(title, message);
};
function flatten(menu) {
  return menu?.items.flatMap((item) => [item, ...flatten(item.submenu)]) ?? [];
}
const poll = setInterval(() => {
  const window = readyWindow();
  if (!window) return;
  if (version === config.target) {
    clearInterval(poll);
    record("new-window");
    app.quit();
    return;
  }
  const restart = flatten(Menu.getApplicationMenu()).find(
    (item) => item.enabled && item.label.includes(config.target),
  );
  if (!restart || phase === "failure" || phase === "success") return;
  if (phase === "waiting") {
    const staged = JSON.parse(
      fs.readFileSync(path.join(profile, "updates", "staged.json")),
    );
    if (
      staged.version !== config.target ||
      !fs.existsSync(path.join(staged.prepared, "app.asar"))
    )
      return;
    record("ready", { label: restart.label });
    phase = "failure";
    // Make only this process's PowerShell launcher unavailable for the first click.
    process.env.SystemRoot = path.join(root, "missing-windows-directory");
  } else {
    phase = "success";
    record("retry", { label: restart.label });
  }
  restart.click(undefined, window);
}, 250);
import(
  pathToFileURL(path.join(root, source, "dist-electron", "main.js")).href
).catch((e) => {
  record("unexpected-error", { message: String(e) });
  app.exit(1);
});
