import { app, BrowserWindow, session } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { AppEvent, Snapshot } from "../../shared/types";
import type { ModelCatalog } from "../../shared/model-catalog-api";
import { Store } from "../../electron/store/store";
import { registerCollectionHandlers } from "../../electron/ipc/collections";
import { createNativeAccountApi } from "../../electron/official-ui/api/native-account-api";
import { startOfficialUiServer, cookieName } from "../../electron/official-ui/server";
import { createNativeHost } from "../../electron/official-ui/native";

const profile = process.env.CLAUDEX_F025_PROFILE;
const assets = process.env.CLAUDEX_F025_ASSETS;
if (!profile || !path.isAbsolute(profile) || !assets || !path.isAbsolute(assets))
  throw Error("Set absolute F025 profile and official asset paths.");
fs.mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
app.setName("Claudex F025 isolated test");
const projectId = "5390b92d-1e65-40a7-94ef-76b03d359025";
const owner = "f025-native-synthetic";
const identity = {};
const store = new Store(profile);
if (!store.projects.some(project => project.id === projectId)) {
  store.projects.push({ id: projectId, kind: "chat", name: "F025 native acceptance", description: "Synthetic text knowledge", instructions: "", createdAt: Date.now() });
  store.flush();
}
const knowledgeFolder = path.join(profile, "projects", projectId, "knowledge");
fs.mkdirSync(knowledgeFolder, { recursive: true });
const handlers = new Map<string, (...args: unknown[]) => unknown>();
registerCollectionHandlers((name, handler) => handlers.set(name, handler), {
  store,
  onSettingsChanged() {},
  onAccountActivated() {},
  onAccountDeactivating() {},
} as unknown as Parameters<typeof registerCollectionHandlers>[1]);
const listeners = new Set<(event: AppEvent) => void>();
const catalog: ModelCatalog = { defaultModel: "fixture-model", items: [{ id: "fixture-model", displayName: "Fixture model", description: "Synthetic", badges: [], sort: 0, hidden: false, isDefault: true, usageHint: "", efforts: ["none"] }] };
const snapshot = (): Snapshot => ({ artifactLibrary: { version: 1, copies: [], pinned: [] }, artifactShares: [], dismissedBackgroundTasks: [], approvals: [], replyFeedback: {}, engine: {state:"ready"}, settings: store.settings, conversations: [], projects: structuredClone(store.projects), platform: process.platform });
const ctx: Parameters<typeof createNativeAccountApi>[0] = {
  root: assets,
  account: () => ({ id: owner, name: "F025 synthetic", email: "fixture@example.invalid" }),
  sessionIdentity: () => identity,
  stateDirectory: () => profile,
  isCurrent: () => true,
  settings: () => store.settings,
  listConversations: async () => [],
  loadConversation: async () => undefined,
  snapshot: async () => snapshot(),
  modelCatalog: async () => catalog,
  onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  appVersion: "F025 isolated",
  log: () => {},
  call: async (method, ...args) => {
    const handler = handlers.get(method);
    if (handler) return handler(...args);
    if (method === "snapshot") return snapshot();
    if (method === "modelCatalog") return catalog;
    if (method === "memoryStatus" || method === "memoryControlsState") return undefined;
    if (["listSkills", "mcpServers", "listPlugins", "artifactNotes"].includes(method)) return [];
    throw Error("Unsupported isolated method: " + method);
  },
};

app.whenReady().then(async () => {
  const api = createNativeAccountApi(ctx);
  const server = await startOfficialUiServer({ root: assets, api, debugQuit: () => app.quit() });
  const ses = session.fromPartition("f025-synthetic");
  await ses.cookies.set({ url: server.origin, name: cookieName, value: server.token, httpOnly: true, sameSite: "strict" });
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  ses.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    callback({ cancel: url.origin !== server.origin && !["blob:", "data:", "devtools:"].includes(url.protocol) });
  });
  const window = new BrowserWindow({ width: 1300, height: 900, show: true, title: "Claudex F025 isolated test", webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(assets, "host/official-preload.cjs") } });
  const native = createNativeHost(server.origin, ctx, {});
  native.host.attach(window);
  const build = JSON.parse(fs.readFileSync(path.join(assets, "data/build.json"), "utf8"));
  window.webContents.setUserAgent(`${window.webContents.getUserAgent()} Claude/${build.installedDesktopVersion ?? "4.4212.0"}`);
  app.on("before-quit", () => { native.dispose(); void server.close(); });
  app.on("window-all-closed", () => app.quit());
  await window.loadURL(server.origin + "/project/" + projectId);
  fs.writeFileSync(path.join(profile, "ready.json"), JSON.stringify({ pid: process.pid, origin: server.origin, projectUrl: server.origin + "/project/" + projectId, knowledgeFolder, assets }, null, 2));
  console.log("F025_NATIVE_READY");
}).catch(error => { console.error(error); app.exit(1); });
