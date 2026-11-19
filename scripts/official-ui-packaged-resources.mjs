import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { verifyPackagedBootstrap } from "./official-ui-bootstrap-defaults.mjs";
import { deriveOfficialUiSessionTransferPreload } from "./official-ui-host-session-export.mjs";
import { verifyOfficialQuickAccessAddon } from "./official-quick-access-resource.mjs";
import { desktopBootDocument, desktopBootSource, mainWindowSource } from "./official-ui-desktop-boot.mjs";
import { brandedDesktopShell, brandedQuickWindow } from "./official-ui-branding.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const prefix = "claude-frontend-4.4212.0/";
const nativeData = {
  "native-ipc-contract.json": "recovery/native-ipc-contract.json",
  "conversation-protocol.json": "recovery/conversation-protocol.json",
  "display-settings.json": "recovery/official-display-settings.json",
  "capabilities.json": "src/cloud/development/official-capabilities.json",
  "build.json": "recovery/official-live-document.json",
};
const nativeHost = {
  "official-preload.cjs": "electron/official-preload.cjs",
  "main-window-preload.cjs": "reference/desktop-main/mainWindow.js",
  "quick-window-preload.cjs": "reference/desktop-main/quickWindow.js",
  "package.json": "electron/recovered/package.json",
  "code-transcript.cjs": "electron/recovered/code-transcript.cjs",
  "index.chunk--vdvhZkd.js": "electron/recovered/index.chunk--vdvhZkd.js",
  "transcript.cjs": "electron/recovered/transcript.cjs",
};
const generatedNativeUi = {
  "app.js": "b818b2296db9a85130a8ec30a60c1264fc3ff72ca75642568e4336f8e49b65db",
  "development/native-host.js": "68fc317e938061495bf43a84ba8539ad0ed53ec8dbea2ebe43b1df437b2c52aa",
  "development/official-sidebar-settings.js": "5c6dcbdf1c5628d69fa5544c57e3d8c75aeb4dacfdc4d938ce7eeadc42a05ea3",
  "development/official-capabilities.js": "e4b92f0651bfe0157293f1713ee5c57a125662e801bd98e4be8ecdc8e0bdbf38",
};

function checkedDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Packaged resource directory must not be a symlink: " + directory);
}
function checkedFile(directory, relative) {
  if (!relative || relative.split("/").some((part) => !part || part === "." || part === ".."))
    throw Error("Invalid packaged resource path.");
  let current = directory;
  checkedDirectory(current);
  for (const [index, part] of relative.split("/").entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (index === relative.split("/").length - 1 ? !stat.isFile() : !stat.isDirectory()))
      throw Error("Packaged resource must be an ordinary file: " + relative);
  }
  return fs.readFileSync(current);
}
function requireNames(directory, expected) {
  checkedDirectory(directory);
  const actual = fs.readdirSync(directory).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) throw Error("Unexpected packaged resource entries: " + directory);
}
function pinnedFile(directory, relative, source, original) {
  const record = original.get(prefix + source), bytes = checkedFile(directory, relative);
  if (!record || bytes.length !== record.bytes || sha(bytes) !== record.sha256)
    throw Error("Packaged resource differs from pinned source: " + relative);
  return bytes;
}
function listFiles(directory, prefixPath = "") {
  checkedDirectory(directory);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefixPath ? prefixPath + "/" + entry.name : entry.name;
    if (entry.isSymbolicLink()) throw Error("Packaged resource cannot be a symlink: " + relative);
    if (entry.isDirectory()) return listFiles(path.join(directory, entry.name), relative);
    if (!entry.isFile()) throw Error("Unsupported packaged resource: " + relative);
    return [relative];
  });
}

/** Verify all shipped native shell, non-audit data, and isolated preview resources. */
export function verifyPackagedOfficialResources(projectRoot, original, options = {}) {
  const build = path.join(projectRoot, "build"), assembled = options.officialUi ?? path.join(build, "official-ui");
  checkedDirectory(build);
  checkedDirectory(assembled);
  const host = path.join(assembled, "host"), data = path.join(assembled, "data"), ui = path.join(assembled, "ui");
  const { hostSessionExport, hostApi } = JSON.parse(checkedFile(assembled, "manifest.json"));
  requireNames(host, [...Object.keys(nativeHost), "window-manager.cjs", "claudex-shim.cjs"]);
  requireNames(data, [...Object.keys(nativeData), "bootstrap-defaults.json", "locale-recovery.json"]);
  requireNames(ui, ["index.html", "app.js", "assets", "development", "i18n", "images", ...(hostApi ? ["official-status-preview.html"] : [])]);
  requireNames(path.join(ui, "development"), ["native-host.js", "official-sidebar-settings.js", "official-sidebar-settings.json", "official-capabilities.js", "official-capabilities.json"]);
  for (const [name, source] of Object.entries(nativeData)) pinnedFile(data, name, source, original);
  const quickEntry = path.join(assembled, "quick-window"), quickSource = "src/cloud/desktop/quick_window/";
  const quickPrefix = prefix + quickSource;
  const quickFiles = [...original.keys()].filter(name => name.startsWith(quickPrefix)).map(name => name.slice(quickPrefix.length)).sort();
  if (!quickFiles.length || JSON.stringify(listFiles(quickEntry).sort()) !== JSON.stringify(quickFiles))
    throw Error("Packaged Quick Entry resource set mismatch.");
  for (const name of quickFiles) {
    if (name === "quick-window.html") {
      const upstream = pinnedFile(options.extracted, prefix + quickSource + name, quickSource + name, original);
      if (!checkedFile(quickEntry, name).equals(Buffer.from(brandedQuickWindow(upstream.toString("utf8")))))
        throw Error("Packaged Quick Entry document differs from its source derivation.");
    } else {
      pinnedFile(quickEntry, name, quickSource + name, original);
    }
  }
  const mainWindow = path.join(assembled, "main-window"), mainPrefix = prefix + mainWindowSource;
  const mainFiles = [...original.keys()].filter(name => name.startsWith(mainPrefix)).map(name => name.slice(mainPrefix.length));
  if (!mainFiles.length || JSON.stringify(listFiles(mainWindow).sort()) !== JSON.stringify([...mainFiles, "view.html"].sort()))
    throw Error("Packaged main window resource set mismatch.");
  for (const name of mainFiles) {
    if (name === "assets/MainWindowPage-DTApdGAL.js") {
      const upstream = pinnedFile(options.extracted, prefix + mainWindowSource + name, mainWindowSource + name, original);
      if (!checkedFile(mainWindow, name).equals(Buffer.from(brandedDesktopShell(upstream.toString("utf8")))))
        throw Error("Packaged desktop shell differs from its source derivation.");
    } else {
      pinnedFile(mainWindow, name, mainWindowSource + name, original);
    }
  }
  const view = desktopBootDocument(
    checkedFile(ui, "index.html").toString("utf8"),
    pinnedFile(options.extracted, prefix + desktopBootSource, desktopBootSource, original).toString("utf8"),
  );
  if (!checkedFile(mainWindow, "view.html").equals(Buffer.from(view)))
    throw Error("Packaged desktop startup document differs from its source derivation.");
  const addon = path.join(assembled, "quick-access.node");
  if (fs.existsSync(addon)) verifyOfficialQuickAccessAddon(addon);
  if (hostApi) checkedFile(ui, "official-status-preview.html");
  for (const [name, source] of Object.entries(nativeHost)) {
    if (name !== "official-preload.cjs" || !hostSessionExport) {
      pinnedFile(host, name, source, original);
      continue;
    }
    const key = prefix + source, record = original.get(key);
    const upstream = fs.readFileSync(path.join(options.extracted, key));
    if (!record || upstream.length !== record.bytes || sha(upstream) !== record.sha256)
      throw Error("Session transfer preload source differs from the pinned archive");
    const expected = deriveOfficialUiSessionTransferPreload(upstream.toString("utf8"));
    if (!checkedFile(host, name).equals(Buffer.from(expected)))
      throw Error("Packaged session transfer preload differs from its source derivation");
  }
  const shim = checkedFile(host, "claudex-shim.cjs"), ownedShim = checkedFile(projectRoot, "electron/official-ui/page-shim.cjs");
  if (!shim.equals(ownedShim)) throw Error("Packaged native shim differs from its source.");
  checkedFile(host, "window-manager.cjs");
  checkedFile(data, "locale-recovery.json");
  checkedFile(ui, "index.html");
  verifyPackagedBootstrap(assembled);
  for (const [name, digest] of Object.entries(generatedNativeUi))
    if (sha(checkedFile(ui, name)) !== digest) throw Error("Generated native UI checksum mismatch: " + name);
  for (const name of ["official-sidebar-settings.json", "official-capabilities.json"])
    pinnedFile(ui, "development/" + name, "src/cloud/development/" + name, original);
  const preview = options.userContent ?? path.join(build, "official-usercontent"), previewPrefix = prefix + "src/usercontent/";
  const expected = [...original.keys()].filter((name) => name.startsWith(previewPrefix)).map((name) => name.slice(previewPrefix.length)).sort();
  const actual = listFiles(preview).sort();
  if (!expected.length || JSON.stringify(actual) !== JSON.stringify([...expected, "mcp_apps.html"].sort()))
    throw Error("Packaged user-content resource set mismatch.");
  if (!checkedFile(preview, "mcp_apps.html").equals(checkedFile(projectRoot, "electron/official-ui/assets/mcp_apps.html")))
    throw Error("Packaged MCP App sandbox differs from its source.");
  for (const name of expected) pinnedFile(preview, name, "src/usercontent/" + name, original);
}
