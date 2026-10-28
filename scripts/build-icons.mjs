/**
 * Renders build/icon.svg (the Claudex app icon, 1024 grid) into every icon
 * the builds use: build/icon.png, build/icon.iconset + build/icon.icns (macOS,
 * via iconutil), build/icon.ico (Windows, PNG entries) and the web
 * home-screen icon in public-web/. Run with Electron:  npx electron scripts/build-icons.mjs
 */
import { app, BrowserWindow } from "electron";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const svg = fs.readFileSync(path.join(root, "build", "icon.svg"), "utf8");

async function render(win, size) {
  const html = `<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" width="${size}" height="${size}"></body></html>`;
  win.setContentSize(size, size);
  await win.loadURL(
    `data:text/html;base64,${Buffer.from(html).toString("base64")}`,
  );
  await new Promise((r) => setTimeout(r, 120));
  const image = await win.webContents.capturePage({
    x: 0,
    y: 0,
    width: size,
    height: size,
  });
  return image.resize({ width: size, height: size, quality: "best" }).toPNG();
}

function ico(entries) {
  const header = Buffer.alloc(6 + 16 * entries.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...entries.map((e) => e.png)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  const png = {};
  for (const size of [16, 24, 32, 48, 64, 128, 180, 256, 512, 1024])
    png[size] = await render(win, size);
  const set = path.join(root, "build", "icon.iconset");
  fs.mkdirSync(set, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    fs.writeFileSync(path.join(set, `icon_${size}x${size}.png`), png[size]);
    fs.writeFileSync(
      path.join(set, `icon_${size}x${size}@2x.png`),
      png[size * 2],
    );
  }
  fs.writeFileSync(path.join(root, "build", "icon.png"), png[1024]);
  execFileSync("iconutil", [
    "-c",
    "icns",
    set,
    "-o",
    path.join(root, "build", "icon.icns"),
  ]);
  fs.writeFileSync(
    path.join(root, "build", "icon.ico"),
    ico(
      [16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: png[size] })),
    ),
  );
  // The web tab icon is the mark alone; only the home-screen icon keeps the app
  // icon's plate.
  const web = path.join(root, "public-web");
  fs.writeFileSync(path.join(web, "apple-touch-icon.png"), png[180]);
  console.log("icons written");
  app.quit();
});
