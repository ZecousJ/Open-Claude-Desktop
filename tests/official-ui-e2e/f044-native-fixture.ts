import { app, BrowserWindow, session } from "electron";
import fs from "node:fs";
import path from "node:path";
import { Store } from "../../electron/store/store";
import { saveSessionConnectorPreference } from "../../electron/ipc/session-connector-preference";
import { startOfficialUiServer, cookieName } from "../../electron/official-ui/server";
import { createNativeAccountApi } from "../../electron/official-ui/api/native-account-api";
import { createNativeHost } from "../../electron/official-ui/native";
import type { Approval, AppEvent } from "../../shared/types";

const profile = process.env.CLAUDEX_F044_PROFILE!;
if (!profile || !path.isAbsolute(profile)) throw Error("Missing fixture profile");
fs.mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
app.setName("Claudex F044 isolated test");
app.commandLine.appendSwitch("remote-debugging-port", process.env.CLAUDEX_F044_CDP_PORT!);
const id = "8cfc6561-4d86-4efa-8e94-72a293f83a45";
const store = new Store(profile);
if (!store.conversations.length) {
  store.conversations = [{ id, title: "F044 native fixture", mode: "code", cwd: profile, providerId: "p", model: "fixture-model", createdAt: Date.now(), updatedAt: Date.now(), pinned: false, archived: false, turns: [] } as any];
  store.flush();
}
const identity = {};
const server = { name: "fixture_connector", url: "https://fixture.invalid/mcp", state: "ready", toolList: [{ name: "fixture_lookup", description: "Look up a fixture", enabled: true, definition: { name: "fixture_lookup", description: "Look up a fixture", inputSchema: { type: "object", properties: {} } } }] };
store.settings.mcpServers = { [server.name]: { url: server.url } };
const listeners = new Set<(event: AppEvent) => void>();
const emit = (event: AppEvent) => listeners.forEach(listener => listener(event));
const approvals: Approval[] = [];
function elicitationFixture() {
  if (process.env.CLAUDEX_F044_TEST_ELICITATION !== "1") return;
  const conversation = store.conversation(id);
  const threadId = "f044-thread", turnId = "f044-turn";
  conversation.threadId = threadId;
  conversation.turns = [{
    id: turnId, status: "inProgress", prompt: "Ask the fixture connector",
    attachments: [], items: [], createdAt: Date.now(),
  }];
  const request = (requestId: number, params: Record<string, unknown>): Approval => ({
    id: requestId,
    conversationId: id,
    method: "mcpServer/elicitation/request",
    params: { threadId, turnId, serverName: server.name, _meta: null, ...params },
  });
  const form = request(1, {
    mode: "form",
    message: "Choose your fixture options.",
    requestedSchema: {
      type: "object",
      properties: {
        project: { type: "string", title: "Project name" },
        copies: { type: "integer", title: "Number of copies", minimum: 2 },
        includeDrafts: { type: "boolean", title: "Include drafts" },
      },
      required: ["project", "copies", "includeDrafts"],
    },
  });
  const link = request(2, {
    mode: "url",
    message: "Complete the fixture connection.",
    url: "https://example.com/f044-connect",
    elicitationId: "f044-connect",
  });
  approvals.push(form);
  const responses: { id: Approval["id"]; response: unknown }[] = [];
  return (approval: Approval, response: unknown) => {
    if (approvals[0] !== approval) throw Error("The fixture approval changed.");
    responses.push({ id: approval.id, response });
    fs.writeFileSync(path.join(profile, "elicitation-responses.json"), JSON.stringify(responses));
    approvals.shift();
    emit({ type: "approval-resolved", id: approval.id });
    if (approval === form) {
      approvals.push(link);
      emit({ type: "approval", approval: link });
    }
  };
}
const respondToLocalCodeElicitation = elicitationFixture();
const settings = () => ({ ...store.settings, providers: [{ id: "p", model: "fixture-model", models: ["fixture-model"], protocol: "responses" }], activeProviderId: "p" });
const catalog = { defaultModel: "fixture-model", items: [{ id: "fixture-model", displayName: "Fixture model", efforts: ["none", "low"] }] };
const list = async () => structuredClone(store.conversations);
const load = async (wanted: string) => structuredClone(store.conversations.find(c => c.id === wanted));
const call = async (method: string, ...args: any[]) => {
  if (method === "mcpServers") return { servers: [server] };
  if (method === "snapshot") return { settings: settings(), conversations: store.conversations, projects: [], approvals };
  if (method === "modelCatalog") return catalog;
  if (["listSkills", "listPlugins", "artifactNotes"].includes(method)) return [];
  if (["memoryStatus", "memoryControlsState"].includes(method)) return undefined;
  if (method === "updateConversation") {
    return saveSessionConnectorPreference({ store, activeAccount: { id: "367edcec-2d36-41c3-905a-3bffbd567000" } as any, accountActivationIdentity: identity, push: emit } as any, args[0], args[1]);
  }
  throw Error("Unsupported synthetic method " + method);
};
const ctx: any = { root: path.join(process.cwd(), "build/official-ui"), account: () => ({ id: "367edcec-2d36-41c3-905a-3bffbd567000", name: "Fixture", email: "fixture@example.invalid" }), sessionIdentity: () => identity, stateDirectory: () => profile, isCurrent: () => true, settings, listConversations: list, loadConversation: load, localListConversations: list, localLoadConversation: load, call, localCall: call, respondToLocalCodeElicitation, snapshot: () => call("snapshot"), modelCatalog: async () => catalog, onEvent: (listener: (event: AppEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); }, log: (...args: unknown[]) => console.log("LOG", ...args), appVersion: "test" };
app.whenReady().then(async () => {
  const api = createNativeAccountApi(ctx);
  const server = await startOfficialUiServer({ root: ctx.root, api, debugQuit: () => app.quit() });
  const ses = session.fromPartition("f044-synthetic");
  await ses.cookies.set({ url: server.origin, name: cookieName, value: server.token, httpOnly: true, sameSite: "strict" });
  ses.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  ses.webRequest.onBeforeRequest((details, cb) => { const u = new URL(details.url); cb({ cancel: !(u.origin === server.origin || ["blob:", "data:", "devtools:"].includes(u.protocol)) }); });
  const window = new BrowserWindow({ show: false, width: 1300, height: 900, webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(ctx.root, "host/official-preload.cjs") } });
  const features = JSON.parse(fs.readFileSync(path.join(ctx.root, "data/capabilities.json"), "utf8")).configurations[0];
  const native = createNativeHost(server.origin, ctx, features);
  native.host.attach(window);
  const build = JSON.parse(fs.readFileSync(path.join(ctx.root, "data/build.json"), "utf8"));
  window.webContents.setUserAgent(`${window.webContents.getUserAgent()} Claude/${build.installedDesktopVersion ?? "4.4212.0"}`);
  app.on("before-quit", () => { native.dispose(); void server.close(); });
  app.on("window-all-closed", () => app.quit());
  await window.loadURL(server.origin + "/epitaxy/local_" + id);
  console.log("F044_NATIVE_READY");
}).catch(error => { console.error(error); app.exit(1); });
