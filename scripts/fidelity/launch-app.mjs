/** Launch the real built app at reference dimensions. Use an isolated CLAUDEX_DATA_DIR. */
import { app, screen } from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
if (!process.env.CLAUDEX_DATA_DIR)
  throw new Error(
    "Set CLAUDEX_DATA_DIR to an isolated synthetic fixture profile.",
  );
const width = Number(process.env.CLAUDEX_FIXTURE_WIDTH ?? 1747);
const height = Number(process.env.CLAUDEX_FIXTURE_HEIGHT ?? 1063);
const fixtureX =
  process.env.CLAUDEX_FIXTURE_X === undefined
    ? undefined
    : Number(process.env.CLAUDEX_FIXTURE_X);
const fixtureY =
  process.env.CLAUDEX_FIXTURE_Y === undefined
    ? undefined
    : Number(process.env.CLAUDEX_FIXTURE_Y);
if (
  !Number.isInteger(width) ||
  width < 840 ||
  width > 3000 ||
  !Number.isInteger(height) ||
  height < 700 ||
  height > 2000
)
  throw new Error("Fixture window dimensions are out of range.");
if (
  (fixtureX !== undefined && !Number.isInteger(fixtureX)) ||
  (fixtureY !== undefined && !Number.isInteger(fixtureY))
)
  throw new Error("Fixture window position must use integer coordinates.");
app.on("browser-window-created", (_event, window) => {
  window.webContents.once("did-finish-load", () => {
    const display = screen
      .getAllDisplays()
      .sort((a, b) => b.workArea.width - a.workArea.width)[0];
    if (!display) throw new Error("No display available for fixture window.");
    const x =
      fixtureX ??
      display.workArea.x +
        Math.max(0, Math.floor((display.workArea.width - width) / 2));
    const y =
      fixtureY ??
      display.workArea.y +
        Math.max(0, Math.floor((display.workArea.height - height) / 2));
    window.setBounds({ x, y, width, height });
  });
});
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
void import(pathToFileURL(path.join(root, "dist-electron/main.js")).href);
