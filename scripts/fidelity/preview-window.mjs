/** Dedicated local-only evidence window; never reuses a user profile. */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const profile = fs.mkdtempSync(
  path.join(os.tmpdir(), "claudex-motion-preview-"),
);
app.setPath("userData", profile);
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1747,
    height: 1063,
    backgroundColor: "#111111",
    title: "Claudex motion evidence fixture",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const page = process.argv.includes("--scroll") ? "scroll" : "activity";
  await window.loadURL(`http://127.0.0.1:5173/fidelity/${page}.html`);
});
app.on("window-all-closed", () => app.quit());
app.on("quit", () => fs.rmSync(profile, { recursive: true, force: true }));
