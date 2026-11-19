import { randomBytes } from "node:crypto";
import { z } from "zod";
import { organizationUuid } from "../../electron/official-ui/api/context";
import {
  cloudCodeSessionKey,
  isOwnedCloudCodeSession,
} from "../../electron/official-ui/api/cloud-code-history";
import { rpcRunner } from "../../electron/ssh/remote-workspace";
import {
  codePreviewPort,
  codePreviewRequestBytes,
  codePreviewRequestHeaders,
  codePreviewResponseBytes,
  officialCodePreviewControl,
} from "../../shared/official-code-preview";
import type { OfficialUiReadResponse } from "../../shared/official-ui-web";
import { browserPolicyOf } from "../../shared/client-policy";
import type { Conversation } from "../../shared/types";
import type { LinkWebSession } from "../../shared/web-protocol";
import type { CallFrame, Dispatcher } from "./dispatcher";
import type { WebAppContext } from "./web-app-context";

const leaseDuration = 2 * 60_000;
const leases = new WeakMap<WebAppContext, Map<string, PreviewLease>>();
const relayInput = z.strictObject({
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
  path: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^\/(?![\/\\])/),
  headers: z.partialRecord(
    z.enum(codePreviewRequestHeaders),
    z.string().max(8192),
  ),
  body: z.string().max(Math.ceil(codePreviewRequestBytes / 3) * 4),
});
const relayOutput = z.object({
  status: z.number().int().min(200).max(599),
  headers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  body: z.string(),
});
type RelayRequest = z.infer<typeof relayInput>;

interface PreviewLease {
  webSession: LinkWebSession;
  conversationId: string;
  conversationCreatedAt: number;
  spaceId: string;
  port: number;
  activation: unknown;
  expires: number;
}

function ownedSpace(conversation: Conversation, owner: string) {
  return conversation.environment?.kind === "space" &&
    conversation.cwd &&
    !conversation.archived &&
    !conversation.linkedToComputer &&
    !conversation.chatDeviceBinding &&
    !conversation.deviceChatOrigin &&
    isOwnedCloudCodeSession(conversation, owner)
    ? conversation.environment.spaceId
    : undefined;
}

function current(dispatcher: Dispatcher, ctx: WebAppContext) {
  return (
    !ctx.closedFlag &&
    !ctx.signedOut &&
    !ctx.accountRetiring &&
    dispatcher.context(ctx.userId) === ctx &&
    ctx.activeAccount &&
    browserPolicyOf(ctx.policy()).enabled !== false &&
    ctx.activeAccount
  );
}

function lease(dispatcher: Dispatcher, userId: number, token: unknown) {
  const ctx = dispatcher.context(userId);
  if (!ctx || typeof token !== "string") return;
  const account = current(dispatcher, ctx);
  const entry = leases.get(ctx)?.get(token);
  if (
    !account ||
    !entry ||
    entry.expires <= dispatcher.now() ||
    entry.activation !== ctx.officialSessionIdentity()
  )
    return;
  const conversation = ctx.store.conversations.find(
    (row) =>
      row.id === entry.conversationId &&
      row.createdAt === entry.conversationCreatedAt,
  );
  if (!conversation || ownedSpace(conversation, account.id) !== entry.spaceId)
    return;
  return { ctx, entry, conversation };
}

const json = (status: number, value: unknown): OfficialUiReadResponse => ({
  status,
  contentType: "application/json",
  body: Buffer.from(JSON.stringify(value)),
});

export async function runOfficialCodePreviewControl(
  dispatcher: Dispatcher,
  frame: CallFrame,
  ctx: WebAppContext,
  control: NonNullable<ReturnType<typeof officialCodePreviewControl>>,
  request: Record<string, unknown>,
) {
  const account = current(dispatcher, ctx);
  const webSession = frame.user.webSession;
  if (
    !dispatcher.guard.modes.includes("code") ||
    !account ||
    !webSession ||
    request.codeOrganizationId !== organizationUuid(account.id)
  )
    return json(404, { error: "Code preview unavailable." });
  const conversation = ctx.store.conversations.find(
    (row) =>
      ownedSpace(row, account.id) &&
      cloudCodeSessionKey(row, account.id) === control.key,
  );
  const spaceId = conversation && ownedSpace(conversation, account.id);
  if (!conversation || !spaceId)
    return json(404, { error: "Code session not found." });
  const activation = ctx.officialSessionIdentity();
  if (control.kind === "status") {
    if (request.body !== undefined || request.contentType !== undefined)
      return json(400, { error: "Invalid preview status request." });
    const result = await inSpace(ctx, conversation, spaceId, control.port);
    if (
      !current(dispatcher, ctx) ||
      ctx.officialSessionIdentity() !== activation
    )
      return json(404, { error: "Code preview unavailable." });
    return json(200, {
      tunnel_connected: result !== undefined,
      server_listening: result === true,
      probe_error: "",
    });
  }
  const { body, contentType } = request;
  let port: unknown;
  try {
    if (
      !(body instanceof Uint8Array) ||
      body.byteLength > 1024 ||
      typeof contentType !== "string" ||
      !/^application\/json(?:\s*;|$)/i.test(contentType)
    )
      throw Error();
    ({ port } = z
      .strictObject({ port: z.number() })
      .parse(JSON.parse(Buffer.from(body).toString("utf8"))));
  } catch {
    return json(400, { error: "Invalid preview token request." });
  }
  if (!codePreviewPort(port))
    return json(400, { error: "Invalid preview port." });
  const now = dispatcher.now();
  let accountLeases = leases.get(ctx);
  if (!accountLeases) leases.set(ctx, (accountLeases = new Map()));
  let token: string | undefined;
  for (const [key, entry] of accountLeases) {
    if (entry.activation !== activation) accountLeases.delete(key);
    else if (
      entry.conversationId === conversation.id &&
      entry.conversationCreatedAt === conversation.createdAt &&
      entry.port === port &&
      entry.spaceId === spaceId &&
      entry.webSession.id === webSession.id
    )
      token = key;
  }
  if (!token) {
    if (accountLeases.size >= 32) {
      const expired = [...accountLeases].find(
        ([, entry]) => entry.expires <= now,
      );
      if (expired) accountLeases.delete(expired[0]);
    }
    if (accountLeases.size >= 32)
      return json(429, { error: "Too many open preview ports." });
    token = randomBytes(16).toString("hex");
  }
  const expires = now + leaseDuration;
  accountLeases.set(token, {
    webSession,
    conversationId: conversation.id,
    conversationCreatedAt: conversation.createdAt,
    spaceId,
    port,
    activation,
    expires,
  });
  return json(200, {
    token: `${ctx.userId}-${token}`,
    expires_at: new Date(expires).toISOString(),
  });
}

export function officialCodePreviewLease(
  dispatcher: Dispatcher,
  frame: CallFrame,
) {
  return lease(dispatcher, frame.user.id, frame.args?.[0])?.entry.webSession;
}

export async function officialCodePreviewRequest(
  dispatcher: Dispatcher,
  frame: CallFrame,
) {
  const [token, raw] = frame.args ?? [];
  const owner = lease(dispatcher, frame.user.id, token);
  const request = relayInput.safeParse(raw);
  if (!owner || !request.success) return;
  const { ctx, entry, conversation } = owner;
  const answer = await inSpace(
    ctx,
    conversation,
    entry.spaceId,
    entry.port,
    request.data,
  );
  return lease(dispatcher, frame.user.id, token) ? answer : undefined;
}

async function inSpace(
  ctx: WebAppContext,
  conversation: Conversation,
  spaceId: string,
  port: number,
): Promise<boolean | undefined>;
async function inSpace(
  ctx: WebAppContext,
  conversation: Conversation,
  spaceId: string,
  port: number,
  request: RelayRequest,
): Promise<z.infer<typeof relayOutput> | undefined>;
async function inSpace(
  ctx: WebAppContext,
  conversation: Conversation,
  spaceId: string,
  port: number,
  request?: RelayRequest,
) {
  const engine = ctx.engines
    .all()
    .find(
      (candidate) =>
        candidate.environment?.kind === "space" &&
        candidate.environment.spaceId === spaceId,
    );
  if (!engine?.rpc?.connected || engine.state.state !== "ready") return;
  const result = await rpcRunner(engine.rpc)({
    argv: [
      "node",
      "-e",
      request ? relayScript : probeScript,
      String(port),
      ...(request ? [JSON.stringify(request)] : []),
    ],
    cwd: conversation.cwd,
    timeoutMs: request ? 15_000 : 2_000,
    maxOutput: request
      ? Math.ceil(codePreviewResponseBytes / 3) * 4 + 65_536
      : 1024,
  }).catch(() => undefined);
  if (!request) return result?.code === 0;
  if (result?.code !== 0) return;
  try {
    return relayOutput.parse(JSON.parse(result.stdout));
  } catch {
    return;
  }
}

const probeScript = `
const net = require("node:net");
const port = Number(process.argv[1]);
const connect = (host, fallback) => {
  const socket = net.connect({host, port});
  socket.once("connect", () => { socket.destroy(); process.exit(0); });
  socket.once("error", fallback);
  socket.setTimeout(700, () => socket.destroy(new Error("timeout")));
};
connect("127.0.0.1", () => connect("::1", () => process.exit(1)));
`;

const relayScript = `
const http = require("node:http");
const port = Number(process.argv[1]);
const {method,path,headers,body} = JSON.parse(process.argv[2]);
const bytes = Buffer.from(body, "base64");
if (bytes.length) headers["content-length"] = bytes.length;
const forward = (hostname, fallback) => {
  const request = http.request({hostname, port, method, path, headers}, response => {
    let size = 0;
    const chunks = [];
    response.on("data", chunk => {
      size += chunk.length;
      if (size > ${codePreviewResponseBytes}) return response.destroy(new Error("limit"));
      chunks.push(chunk);
    });
    response.once("error", () => process.exit(1));
    response.once("end", () => process.stdout.write(JSON.stringify({
      status: response.statusCode, headers: response.headers,
      body: Buffer.concat(chunks).toString("base64"),
    })));
  });
  request.once("error", error => {
    if (fallback && error.code === "ECONNREFUSED") forward("::1", false);
    else process.exit(1);
  });
  request.end(bytes);
};
forward("127.0.0.1", true);
`;
