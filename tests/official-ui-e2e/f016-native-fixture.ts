import { app, BrowserWindow, session } from "electron";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../electron/store/store";
import { storeAttachment } from "../../electron/engine/composer-files";
import { openPolicy } from "../../shared/client-policy";
import {
  startOfficialUiServer,
  cookieName,
} from "../../electron/official-ui/server";
import { createNativeAccountApi } from "../../electron/official-ui/api/native-account-api";
import { createNativeHost } from "../../electron/official-ui/native";

const root = process.cwd(),
  profile = process.env.CLAUDEX_F016_PROFILE!;
if (!profile || !path.isAbsolute(profile))
  throw Error("Missing fixture profile");
fs.mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
app.setName("Claudex F016 isolated test");
app.commandLine.appendSwitch(
  "remote-debugging-port",
  process.env.CLAUDEX_F016_CDP_PORT ?? "43920",
);
const id = "8cfc6561-4d86-4efa-8e94-72a293f83a45",
  owner = "f016-synthetic-" + path.basename(profile),
  identity = {};
const store = new Store(profile);
if (!store.conversations.length) {
  store.conversations = [
    {
      id,
      title: "F016 native fixture",
      mode: "chat",
      providerId: "p",
      model: "fixture-model",
      createdAt: 1,
      updatedAt: 1,
      pinned: false,
      archived: false,
      turns: [
        {
          id: "seed",
          prompt: "Initial question",
          createdAt: 1,
          status: "completed",
          attachments: [],
          items: [
            {
              id: "seed-answer",
              type: "agentMessage",
              text: "The selected visible source here.",
            },
          ],
        },
      ],
    } as any,
  ];
  store.flush();
}
const listeners = new Set<(event: any) => void>(),
  selected = new Map<string, any>();
for (const turn of store.conversations[0].turns)
  for (const file of turn.attachments ?? []) selected.set(file.id, file);
let sideAborts = 0, sideRequests = 0, unknownMissingError = false;
const modelServer = http.createServer(async (req, res) => {
  sideRequests++;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString());
  if (
    (input.tools ?? []).length ||
    !JSON.stringify(input.input).includes("visible source")
  ) {
    res.writeHead(400).end();
    return;
  }
  if (JSON.stringify(input.input).includes("F016 slow side")) {
    let finished = false;
    res.once("close", () => {
      if (!finished) sideAborts++;
    });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Partial side answer" })}\n\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 8000));
    if (res.destroyed) return;
    finished = true;
    res.end(
      `data: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Partial side answer" }] }] } })}\n\n`,
    );
    return;
  }
  const text = "F016 native side answer",
    item = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    };
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const event of [
    { type: "response.output_text.delta", delta: text },
    { type: "response.completed", response: { output: [item] } },
  ])
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
});
const account = () => ({
  id: owner,
  name: "F016 Fixture",
  email: "fixture@example.invalid",
});
const catalog = {
  defaultModel: "fixture-model",
  items: [
    {
      id: "fixture-model",
      displayName: "Fixture model",
      efforts: ["none", "low"],
    },
  ],
};
const ctx: any = {
  root: path.join(root, "build/official-ui"),
  account,
  sessionIdentity: () => identity,
  stateDirectory: () => profile,
  isCurrent: () => true,
  settings: () => ({
    ...store.settings,
    providers: [
      {
        id: "p",
        model: "fixture-model",
        models: ["fixture-model"],
        protocol: "responses",
      },
    ],
    activeProviderId: "p",
  }),
  listConversations: async () => structuredClone(store.conversations),
  loadConversation: async (wanted: string) => {
    const c = store.conversations.find((x) => x.id === wanted);
    return c && structuredClone(c);
  },
  snapshot: async () => ({
    settings: store.settings,
    conversations: structuredClone(store.conversations),
    projects: [],
  }),
  modelCatalog: async () => catalog,
  onEvent: (fn: any) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  log: () => {},
  appVersion: "test",
  sideQuestionGateway: async () => ({
    current: () => true,
    instructions: "Answer only the side question.",
    verifyContext: () => {},
    open: async () => ({
      url: `http://127.0.0.1:${(modelServer.address() as any).port}/v1`,
      token: "fixture",
      path: "a".repeat(64),
    }),
    close: async () => {},
  }),
  call: async (method: string, ...args: any[]) => {
    if (method === "addAttachmentData") {
      const a = storeAttachment(
        path.join(profile, "attachments"),
        args[0],
        args[1],
        openPolicy,
      );
      selected.set(a.id, a);
      return a;
    }
    if (method === "turnAttachment") {
      if (args[1] === "f016-missing-history") {
        if (unknownMissingError) throw Error("/synthetic/private-test-path");
        return null;
      }
      const c = store.conversations.find((x) => x.id === args[0]);
      const file = c?.turns
        .flatMap((t) => t.attachments ?? [])
        .find((a) => a.id === args[1]);
      return file
        ? { name: file.name, data: fs.readFileSync(file.path) }
        : null;
    }
    if (method === "send") {
      const send = args[0],
        c = store.conversation(send.conversationId);
      const files = (send.attachments ?? []).map((a: any) =>
        selected.get(a.id),
      );
      c.turns.push({
        id: randomUUID(),
        prompt: send.text,
        createdAt: Date.now(),
        status: "completed",
        attachments: files,
        items: [
          {
            id: randomUUID(),
            type: "agentMessage",
            text: "F016 native quote accepted",
          },
        ],
        ...(send.completionQuotes
          ? { completionQuotes: send.completionQuotes }
          : {}),
      });
      store.flush();
      const snapshot = structuredClone(c);
      setTimeout(
        () =>
          listeners.forEach((fn) =>
            fn({ type: "conversation", conversation: snapshot }),
          ),
        0,
      );
      return snapshot;
    }
    if (method === "memoryStatus" || method === "memoryControlsState")
      return undefined;
    if (
      ["listSkills", "mcpServers", "listPlugins", "artifactNotes"].includes(
        method,
      )
    )
      return [];
    if (method === "snapshot")
      return {
        settings: store.settings,
        conversations: store.conversations,
        projects: [],
      };
    if (method === "modelCatalog") return catalog;
    throw Error("Unsupported synthetic method " + method);
  },
};
app
  .whenReady()
  .then(async () => {
    await new Promise<void>((resolve) =>
      modelServer.listen(0, "127.0.0.1", resolve),
    );
    const api = createNativeAccountApi(ctx);
    const server = await startOfficialUiServer({
      root: ctx.root,
      api: async (req, res) => {
        if (req.method === "GET" && req.url === "/api/__f016/snapshot") {
          const c = store.conversation(id);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              turns: c.turns.map((turn) => ({
                prompt: turn.prompt,
                completionQuotes: turn.completionQuotes,
              })),
              sideAborts,
              sideRequests,
            }),
          );
          return true;
        }
        if (req.method === "POST" && req.url === "/api/__f016/missing-attachment") {
          const c = store.conversation(id);
          c.turns[0].attachments.push({ id: "f016-missing-history", name: "f016-missing.txt", kind: "text", size: 10, path: "/synthetic/missing" });
          store.flush();
          res.writeHead(204).end();
          return true;
        }
        if (req.method === "POST" && req.url === "/api/__f016/unknown-attachment-error") {
          unknownMissingError = true;
          res.writeHead(204).end();
          return true;
        }
        return api(req, res);
      },
      debugQuit: () => app.quit(),
    });
    const ses = session.fromPartition("f016-synthetic");
    await ses.cookies.set({
      url: server.origin,
      name: cookieName,
      value: server.token,
      httpOnly: true,
      sameSite: "strict",
    });
    ses.setPermissionRequestHandler((_w, _p, callback) => callback(false));
    ses.webRequest.onBeforeRequest((details, callback) => {
      const u = new URL(details.url);
      callback({
        cancel: !(
          u.origin === server.origin ||
          ["blob:", "data:", "devtools:"].includes(u.protocol)
        ),
      });
    });
    const window = new BrowserWindow({
      show: false,
      width: 1300,
      height: 900,
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(ctx.root, "host/official-preload.cjs"),
      },
    });
    const native = createNativeHost(server.origin, ctx, {});
    native.host.attach(window);
    const build = JSON.parse(
      fs.readFileSync(path.join(ctx.root, "data/build.json"), "utf8"),
    );
    window.webContents.setUserAgent(
      `${window.webContents.getUserAgent()} Claude/${build.installedDesktopVersion ?? "4.4212.0"}`,
    );
    app.on("before-quit", () => {
      native.dispose();
      void server.close();
      modelServer.close();
    });
    app.on("window-all-closed", () => app.quit());
    await window.loadURL(server.origin + "/chat/" + id);
    console.log("F016_NATIVE_READY");
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
