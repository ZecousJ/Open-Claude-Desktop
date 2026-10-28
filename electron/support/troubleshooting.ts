/**
 * Help ▸ Troubleshooting, as in the 2.37337.1 desktop: Copy Installation ID,
 * Generate Diagnostic Report, Record Net Log (30s), Disable Hardware
 * Acceleration (a checkbox with a restart prompt) and Reset App Data…. Cowork's
 * VM items and the Claude Code imports have no counterpart in Claudex.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  app,
  clipboard,
  dialog,
  net,
  netLog,
  session,
  shell,
  type BaseWindow,
} from "electron";

const installationFile = () =>
  path.join(app.getPath("userData"), "installation-id");
const accelerationFile = () =>
  path.join(app.getPath("userData"), "hardware-acceleration.json");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** This installation's random id, made on first use (no account or machine data in it). */
export function installationId() {
  const file = installationFile();
  try {
    const saved = fs.readFileSync(file, "utf8").trim();
    if (uuid.test(saved)) return saved;
  } catch {
    // Not made yet.
  }
  const id = crypto.randomUUID();
  try {
    fs.writeFileSync(file, id, { mode: 0o600 });
  } catch {
    // Read-only data folder: the id lasts this run.
  }
  return id;
}

export function copyInstallationId() {
  clipboard.writeText(installationId());
}

/** The checkbox's state: set by the menu, applied at the next start. */
export function hardwareAccelerationDisabled() {
  try {
    const saved = JSON.parse(fs.readFileSync(accelerationFile(), "utf8"));
    return saved?.disabled === true;
  } catch {
    return false;
  }
}

/** Before the app is ready: turns acceleration off when the person chose so. */
export function applyHardwareAccelerationPreference() {
  if (hardwareAccelerationDisabled()) app.disableHardwareAcceleration();
}

export async function setHardwareAccelerationDisabled(
  disabled: boolean,
  translate: (value: string) => string,
  restart: () => void,
) {
  fs.writeFileSync(accelerationFile(), JSON.stringify({ disabled }));
  const { response } = await dialog.showMessageBox({
    type: "info",
    message: translate("Restart required"),
    detail: translate("Restart Claudex to apply the change."),
    buttons: [translate("Later"), translate("Restart now")],
    defaultId: 1,
  });
  if (response === 1) restart();
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/**
 * A report of this build and computer for support: versions, the system,
 * graphics and network state. Nothing from conversations or accounts.
 */
export async function generateDiagnosticReport() {
  const gpu = (() => {
    try {
      return app.getGPUFeatureStatus();
    } catch {
      return undefined;
    }
  })();
  const report = {
    generatedAt: new Date().toISOString(),
    installationId: installationId(),
    app: { name: app.getName(), version: app.getVersion() },
    runtime: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    system: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      cpus: os.cpus().length,
      memoryGb: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
      freeMemoryGb: Math.round((os.freemem() / 2 ** 30) * 10) / 10,
      locale: app.getLocale(),
      uptimeMinutes: Math.round(process.uptime() / 60),
    },
    graphics: {
      hardwareAccelerationDisabled: hardwareAccelerationDisabled(),
      featureStatus: gpu,
    },
    network: { online: net.isOnline() },
  };
  const file = path.join(
    app.getPath("downloads"),
    `claudex-diagnostics-${stamp()}.json`,
  );
  await fs.promises.writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  shell.showItemInFolder(file);
}

/** Records the network for 30 seconds into Downloads, with the progress on the Dock or taskbar. */
export async function recordNetLog(window?: BaseWindow) {
  if (netLog.currentlyLogging) return;
  const duration = 30_000;
  const file = path.join(
    app.getPath("downloads"),
    `claudex-netlog-${stamp()}.json`,
  );
  await netLog.startLogging(file);
  let elapsed = 0;
  const progress = setInterval(() => {
    elapsed += 250;
    if (window && !window.isDestroyed())
      window.setProgressBar(Math.min(elapsed / duration, 1));
  }, 250);
  await new Promise((resolve) => setTimeout(resolve, duration));
  clearInterval(progress);
  await netLog.stopLogging();
  if (window && !window.isDestroyed()) window.setProgressBar(-1);
  shell.showItemInFolder(file);
}

/**
 * Reset App Data…: after a warning, deletes everything in the data folder
 * (settings, caches, sign-in and local chats) except log files, then starts
 * again.
 */
export async function resetAppData(translate: (value: string) => string) {
  const { response } = await dialog.showMessageBox({
    type: "warning",
    message: translate("Reset Application Data"),
    detail: translate(
      "This will delete all application data including settings, cache, and login information. The application will restart after the reset. Are you sure you want to continue?",
    ),
    buttons: [translate("Cancel"), translate("Reset")],
    defaultId: 0,
    cancelId: 0,
  });
  if (response !== 1) return;
  try {
    await session.defaultSession.closeAllConnections();
    await session.defaultSession.clearStorageData();
  } catch {
    // The files go below either way.
  }
  const root = app.getPath("userData");
  for (const name of await fs.promises.readdir(root).catch(() => [])) {
    if (name.endsWith(".log") || name === "logs") continue;
    await fs.promises
      .rm(path.join(root, name), { recursive: true, force: true })
      .catch(() => {});
  }
  await dialog.showMessageBox({
    type: "info",
    message: translate("Reset complete"),
    detail: translate("The application will now restart."),
    buttons: [translate("Restart")],
  });
  app.relaunch();
  app.exit(0);
}
