/** Original drawer with an isolated Store and a deterministic Chat executor. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { HostedShares } from "../../electron/artifacts/hosted-shares";
import { ClaudexSharing } from "../../electron/sub2api/claudex-sharing";
import { createApiAdapter } from "../../electron/official-ui/api/index";
import {
  createGeneratedOutputFixture,
  outputConversationId,
} from "../support/generated-output-fixture";
import type { AppEvent, Turn } from "../../shared/types";

const root = process.argv[2];
if (!root) throw Error("Supply an isolated fixture directory.");
const reopen = fs.existsSync(path.join(root, "profile", "conversations.json"));
const fixture = await createGeneratedOutputFixture(root);
const store = fixture.store;
const chat = store.conversation(outputConversationId);
const artifact = (title: string, text: string) =>
  `<antArtifact identifier="fixture-widget" type="text/markdown" title="Fixture Widget">\n# ${title}\n\n${text}\n</antArtifact>`;

const sharingUrl = process.env.CLAUDEX_F019_SHARING_SERVICE;
if (sharingUrl) {
  const url = new URL(sharingUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
    throw Error("Use a loopback sharing fixture.");
  const sharing = new ClaudexSharing(url.origin);
  const token = "f019-fixture-token";
  const hosted = new HostedShares({
    root: fixture.profile,
    conversation: (id) => (id === chat.id ? chat : undefined),
    changed() {},
    service: {
      status: () => sharing.status(token),
      list: (kind) => sharing.list(token, kind),
      create: (body) => sharing.create(token, body),
      revoke: (id) => sharing.revoke(token, id),
      setAccess: (id, access) => sharing.setAccess(token, id, access),
      invite: (id, email, options) => sharing.invite(token, id, email, options),
      uninvite: (id, email) => sharing.uninvite(token, id, email),
      sharedWithMe: () => sharing.sharedWithMe(token),
      readShared: (id) => sharing.readShared(token, id),
      reportShared: (id, report) => sharing.reportShared(token, id, report),
    },
  });
  fixture.ctx.artifactPublishing = () => hosted;
  fixture.ctx.localCall = async (method: string, id: string) => {
    if (method !== "openShare") throw Error("Unexpected local call.");
    const share = await hosted.find(id);
    if (!share || !(await fetch(share.url)).ok)
      throw Error("Fixture link unavailable.");
    console.log("opened hosted artifact", id);
  };
}

if (!reopen) {
  const time = Date.now();
  chat.title = "F019 Artifact revision proof";
  chat.turns = [
    {
      id: randomUUID(),
      prompt: "Create a fixture widget",
      attachments: [],
      status: "completed",
      createdAt: time - 1000,
      items: [
        {
          id: randomUUID(),
          type: "agentMessage",
          text: artifact("Initial widget", "Original paragraph."),
        },
      ],
    },
    {
      id: randomUUID(),
      prompt: "Update the fixture widget",
      attachments: [],
      status: "completed",
      createdAt: time,
      items: [
        {
          id: randomUUID(),
          type: "agentMessage",
          text: artifact("Current widget", "Paragraph to edit."),
        },
      ],
    },
  ];
  store.flush();
}

const events = new EventEmitter();
const publish = () => {
  store.flush();
  events.emit("event", {
    type: "conversation",
    conversation: structuredClone(chat),
  } satisfies AppEvent);
};
fixture.ctx.onEvent = (listener: (event: AppEvent) => void) => {
  events.on("event", listener);
  return () => events.off("event", listener);
};
const otherCall = fixture.ctx.call;
fixture.ctx.call = async (method: string, ...args: any[]) => {
  if (method !== "send") return otherCall(method, ...args);
  const [input] = args;
  if (
    input.conversationId !== chat.id ||
    !input.text.includes("Replace the selected paragraph") ||
    !input.text.includes("Paragraph to edit.")
  )
    throw Error("Unexpected synthetic edit request.");
  const turn: Turn = {
    id: randomUUID(),
    prompt: input.text,
    attachments: [],
    status: "inProgress",
    createdAt: Date.now(),
    items: [],
  };
  chat.turns.push(turn);
  publish();
  setTimeout(() => {
    turn.items.push({
      id: randomUUID(),
      type: "agentMessage",
      text: artifact("Edited widget", "The selected paragraph was replaced."),
    });
    publish();
    setTimeout(() => {
      turn.status = "completed";
      chat.updatedAt = Date.now();
      publish();
    }, 350);
  }, 400);
  return structuredClone(chat);
};

const adapter = createApiAdapter(fixture.ctx, {
  scoped: true,
  timelineWaitMs: 0,
});
const ui = path.join(fixture.ctx.root, "ui");
const media: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (/^\/(?:api|edge-api|claudeai-rpc)\//.test(pathname)) {
      if (!(await adapter(req, res))) res.writeHead(404).end();
      if (
        /\/artifacts\/|\/PerformAction$|publish(?:ed)?_artifact/.test(pathname)
      )
        console.log(req.method, pathname, res.statusCode);
      return;
    }
    if (pathname === "/app.js") {
      res
        .writeHead(200, { "content-type": "text/javascript" })
        .end('import("/assets/v1/index-BJJTYFi2.js");');
      return;
    }
    const file =
      pathname.startsWith("/chat/") || pathname === "/new"
        ? path.join(ui, "index.html")
        : path.join(ui, pathname);
    if (
      file.startsWith(ui + path.sep) &&
      fs.existsSync(file) &&
      fs.statSync(file).isFile()
    ) {
      res.writeHead(200, {
        "content-type": media[path.extname(file)] ?? "application/octet-stream",
      });
      fs.createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404).end();
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Fixture listener unavailable.");
  console.log(`http://127.0.0.1:${address.port}/chat/${chat.id}`);
});
