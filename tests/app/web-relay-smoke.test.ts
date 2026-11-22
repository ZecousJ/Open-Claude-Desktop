/**
 * End-to-end smoke of the web relay (W-RELAY): the Go relay
 * (backend/backend/internal/claudex/webhost, run by its relaysmoke command)
 * between a browser client (this test: RPC over HTTP, the events
 * WebSocket with a ticket in Sec-WebSocket-Protocol) and the real runner
 * bundle, which links to the relay as the local runner and runs a real codex
 * app-server against the Sub2API mock's gateway.
 *
 * The relay's backends that other packages own are answered by this test:
 * webstore ops (the runner-core in-memory webstore) and key.get (a device
 * registration at the mock). Everything else the runner asks the service
 * (Sub2API user calls, /v1) goes through the relay to the mock.
 *
 * Skipped unless CLAUDEX_RELAY_SMOKE_BIN names a relaysmoke binary for this
 * machine (see the W-RELAY report for the build command) and codex exists.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { build as esbuild } from "esbuild";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { deepCreate, registryFor } from "../../electron/official-ui/api/timeline";
import {
  officialUiActionPath, officialUiTimelinePath, officialUiCapabilitiesPath,
  type OfficialUiReadRequest, type OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import { officialAppearanceCapabilitiesPath } from "../../shared/official-appearance-capability";
import { officialMemoryCapabilitiesPath } from "../../shared/official-memory-capability";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { accountFrom } from "../../src-web/bridge/auth-support";
import { negotiatedOfficialAction } from "../../src-web/official/negotiated-action";
import { negotiatedAppearanceSettings } from "../../src-web/official/negotiated-appearance-action";
import { negotiatedMemoryAction } from "../../src-web/official/negotiated-memory-action";
import { officialBrowserFixture } from "./official-browser-fixture";
import { execFileSync, spawn } from "node:child_process";
import {
  eventsSubprotocols,
  parseServerFrame,
  webPaths,
  webErrorCodes,
  type ServerFrame,
} from "../../shared/web-protocol";
import { splitConversation, type TurnDoc } from "../../shared/web-docs";
import type { ProjectCapabilities } from "../../shared/project-access";
import type { Snapshot } from "../../shared/types";
import { decodeWireValue, encodeWireValue } from "../../shared/web-wire";
import { WebTransport } from "../../shared/web-client/transport";
import { encodeCall } from "../../shared/web-client/codec";
import { gunzipSync } from "node:zlib";
import { deviceRegistrationBody } from "../../shared/claudex-contract";
import { requestJson } from "../../electron/sub2api/http";
import { RemoteAccounts } from "../../electron/sub2api/identity";
import { resolveRuntime } from "../../electron/engine/runtime";
import { MockSub2Api, fakeCipher } from "../support/sub2api-mock";
import { installCuaWebAuth, installOfficialWebMemory, serveOfficialWebForCua } from "../support/official-web-cua-fixture";
import { memoryWebstore } from "../runner/runner-core-support.test.ts";
import { installOfficialUsageFixture } from "../support/official-usage-cua-fixture";

const relayBinary = process.env.CLAUDEX_RELAY_SMOKE_BIN;
// A fault-file path opts into an interactive run through the real Web entry.
const cuaFaultFile = process.env.CLAUDEX_E2E_OFFICIAL_CUA_FAULT_FILE;
const projectMoveCua = !!cuaFaultFile && process.env.CLAUDEX_E2E_OFFICIAL_PROJECT_MOVE === "1";
const searchCua = !!cuaFaultFile && process.env.CLAUDEX_E2E_OFFICIAL_SEARCH_RESULTS === "1";
const searchResultPrompt = "RELAY_WEB_SEARCH_ENABLED";
const searchSourceUrl = "https://example.test/search-evidence";
const projectInstructionA = "F024_PROJECT_INSTRUCTION_A";
const projectInstructionB = "F024_PROJECT_INSTRUCTION_B";
function codexBinary() {
  if (process.env.CLAUDEX_E2E_CODEX) return process.env.CLAUDEX_E2E_CODEX;
  try {
    return resolveRuntime();
  } catch {
    return undefined;
  }
}
const codex = codexBinary();

function sse(text: string, truncate = false, webSearch = false) {
  const id = `msg_${Date.now()}`;
  const searches = webSearch ? [
    { query: "Fixture search with a source", status: "completed", sources: [{ url: searchSourceUrl, title: "Fixture source page" }] },
    { query: "Fixture search with no results", status: "completed", sources: [] },
    { query: "Fixture search failure", status: "failed", sources: [] },
  ].map(({ query, status, sources }, index) => ({
    id: `ws_${Date.now()}_${index}`,
    type: "web_search_call",
    status,
    action: { type: "search", query, sources },
  })) : [];
  const annotations = webSearch ? [{
    type: "url_citation", url: searchSourceUrl, title: "Fixture source page",
    start_index: 2, end_index: 17,
  }] : [];
  const item = {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations }],
  };
  const response = {
    id: `resp_${Date.now()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: "gpt-5.5",
    output: [...searches, item],
    usage: {
      input_tokens: 30,
      output_tokens: 8,
      total_tokens: 38,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  let sequence = 0;
  const events = [
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
    ...searches.flatMap((search, output_index) => [
      { type: "response.output_item.added", output_index, item: { ...search, status: "in_progress" } },
      { type: "response.output_item.done", output_index, item: search },
    ]),
    {
      type: "response.output_item.added",
      output_index: searches.length,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: searches.length,
      item_id: id,
      content_index: 0,
      delta: text,
    },
    { type: "response.output_item.done", output_index: searches.length, item },
    { type: "response.completed", response },
  ];
  return Buffer.from(
    (truncate ? events.slice(0, 3) : events)
      .map(
        (e) =>
          `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: sequence++ })}\n\n`,
      )
      .join(""),
  );
}

/** A browser tab's events socket. */
class Tab {
  frames: ServerFrame[] = [];
  closed?: number;
  socket: WebSocket;
  constructor(url: string, ticket: string, tabId: string, lastSeq?: number) {
    this.socket = new WebSocket(url, eventsSubprotocols(ticket));
    this.socket.onopen = () =>
      this.socket.send(
        JSON.stringify({
          t: "hello",
          v: 1,
          tabId,
          ...(lastSeq !== undefined ? { lastSeq } : {}),
        }),
      );
    this.socket.onmessage = (message) =>
      this.frames.push(parseServerFrame(String(message.data)));
    this.socket.onclose = (event) => (this.closed = event.code);
  }
  of<T extends ServerFrame["t"]>(t: T) {
    return this.frames.filter((f) => f.t === t) as Extract<
      ServerFrame,
      { t: T }
    >[];
  }
  close() {
    this.socket.close(1000);
  }
}

test(
  "web relay end to end: browser, Go relay, runner, codex",
  {
    skip: !relayBinary
      ? "CLAUDEX_RELAY_SMOKE_BIN is not set"
      : codex
        ? false
        : "no codex executable",
    ...(cuaFaultFile ? {} : { timeout: 180_000 }),
  },
  async () => {
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-smoke-dist-"));
    const runnerRelease = process.env.CLAUDEX_RELAY_SMOKE_RUNNER_DIR;
    if (runnerRelease) {
      // Exercise the built release; the test owns only its temporary copy.
      for (const name of ["runner.mjs", "runner.mjs.map", "provider-service.cjs", "connector-sse-mcp.mjs", "sandbox-codex.mjs", "sandbox-runsc.mjs"]) {
        const source = path.join(path.resolve(runnerRelease), name);
        const target = path.join(outdir, name);
        fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
        fs.chmodSync(target, fs.statSync(source).mode & 0o777);
      }
    } else {
      execFileSync(
        process.execPath,
        ["scripts/build-runner.mjs", "--outdir", outdir],
        { stdio: "ignore" },
      );
    }
    const alice = {
      id: 41,
      email: "alice@example.test",
      password: "alice-password-1",
      username: "Alice",
    };
    const bob = {
      id: 42,
      email: "bob@example.test",
      password: "bob-password-1",
      username: "Bob",
    };
    const mock = new MockSub2Api({
      users: [alice, bob],
      userApiKeys: false,
      groups: [
        {
          id: 4,
          name: cuaFaultFile ? "fixture" : "pro",
          platform: "openai",
          subscription_type: "subscription",
          status: "active",
        },
      ],
      subscriptions: [
        {
          id: 1,
          group_id: 4,
          status: "active",
          expires_at: new Date(Date.now() + 86400_000 * 30).toISOString(),
        },
      ],
      models: { status: 200, body: { data: [{ id: "gpt-5.5" }, { id: "gpt-5.4" }] } },
      catalog: {
        default_model: "gpt-5.5",
        items: [
          { id: "gpt-5.5", sort: 1, web_search: "native", ...(cuaFaultFile ? {efforts:["low","high"],default_effort:"high"} : {}) },
          { id: "gpt-5.4", sort: 2, web_search: "none" },
        ],
      },
      policy: { memory: { enabled: true, search_chats: true, generate: true, default_on: false, model: null } },
    });
    const gatewayKeys: string[] = [];
    let searchProbe: { prompt: string; toolTypes?: string[] } | undefined;
    let instructionProbe: { prompt: string; contexts: { active: boolean; a: boolean; b: boolean }[] } | undefined;
    const compareRequests: Record<string, unknown>[] = [];
    let compareHold: Promise<void> | undefined;
    let failModel = false;
    mock.route("POST", "/v1/responses", async (request) => {
      gatewayKeys.push(String(request.headers.authorization));
      if (projectMoveCua) {
        console.log("[official-web-cua] unexpected model request during project move");
        return { status: 503, body: { error: { message: "Project move fixture has no model." } } };
      }
      if (searchProbe && JSON.stringify(request.body.input ?? []).includes(searchProbe.prompt)) {
        searchProbe.toolTypes = Array.isArray(request.body.tools)
          ? request.body.tools.map((tool: { type?: string }) => tool.type ?? "") : [];
      }
      if (instructionProbe && Array.isArray(request.body.input)) {
        type Content = string | { text?: string }[];
        const contentText = (content?: Content) => typeof content === "string"
          ? content : content?.map(({ text }) => text ?? "").join("") ?? "";
        const messages = request.body.input as { role?: string; content?: Content }[];
        const user = messages.filter((message) => message.role === "user").at(-1);
        const prompt = contentText(user?.content);
        if (prompt === instructionProbe.prompt) {
          const developer = messages.filter((message) => message.role === "developer")
            .map((message) => contentText(message.content)).join("\n");
          const active = developer.match(/<collaboration_mode>[\s\S]*?<\/collaboration_mode>/g)?.at(-1);
          instructionProbe.contexts.push({
            active: active !== undefined,
            a: active?.includes(projectInstructionA) ?? false,
            b: active?.includes(projectInstructionB) ?? false,
          });
        }
      }
      if ((searchCua || searchProbe?.prompt === searchResultPrompt) &&
          JSON.stringify(request.body.input ?? []).includes(searchResultPrompt)) {
        if (searchCua) console.log("[official-web-cua] synthetic search response");
        return {
          status: 200,
          body: sse("🔎 Search evidence from the fixture.", false, true),
          headers: { "Content-Type": "text/event-stream" },
        };
      }
      if (searchCua)
        return { status: 503, body: { error: { message: "Only the search fixture prompt is available." } } };
      if (compareHold && JSON.stringify(request.body).includes("COMPARE_TWO_ARMS")) {
        compareRequests.push(request.body);
        await compareHold;
      }
      const fault = cuaFaultFile && fs.existsSync(cuaFaultFile)
        ? fs.readFileSync(cuaFaultFile, "utf8").trim() : failModel ? "error" : "";
      if (cuaFaultFile)
        console.log(`[official-web-cua] gateway call=${gatewayKeys.length} mode=${fault || "complete"}`);
      if (fault === "error") return { status: 400, body: {
        error: { message: "Controlled local model error", type: "invalid_request_error" },
      } };
      return {
        status: 200,
        body: sse("Hello through the relay.", fault === "truncate"),
        headers: { "Content-Type": "text/event-stream" },
      };
    });
    installOfficialWebMemory(mock, [
      { ...alice, generate: !projectMoveCua },
      { ...bob, generate: !!cuaFaultFile && !projectMoveCua },
    ], !!cuaFaultFile);
    if (cuaFaultFile) {
      installCuaWebAuth(mock);
    }
    installOfficialUsageFixture(mock, alice.id, cuaFaultFile);
    await mock.start();
    const loginDirs: string[] = [];
    const signIn = async (user: typeof alice) => {
      const loginDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-smoke-login-"));
      loginDirs.push(loginDir);
      const result = await new RemoteAccounts(
        loginDir,
        mock.url,
        fakeCipher,
      ).login(user.email, user.password);
      if (result.kind !== "signedIn") throw new Error("sign-in");
      return result.session.authorized(async (t) => t);
    };
    const tokens = new Map<number, string>([
      [alice.id, await signIn(alice)],
      [bob.id, await signIn(bob)],
    ]);

    // The driver: webstore ops and key.get for the relay.
    const web = memoryWebstore(50);
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "relay-smoke-state-"));
    const aliceProject = randomUUID();
    const bobProject = randomUUID();
    const readOnlyProject = randomUUID();
    const bobConversation = randomUUID();
    if (!cuaFaultFile || projectMoveCua || searchCua) {
      const seedProject = (userId: number, id: string, name: string, capabilities?: ProjectCapabilities) =>
        web.request("store.projects.put", userId, {
          project: { id, name, kind: "chat", instructions: "", description: "", createdAt: Date.now(), ...(capabilities ? { capabilities } : {}) },
          position: 0,
        });
      await seedProject(alice.id, aliceProject, "Alice project move fixture");
      await seedProject(bob.id, bobProject, "Bob private project fixture");
      if (!cuaFaultFile)
        await seedProject(alice.id, readOnlyProject, "Read-only instructions fixture", { canEditInstructions: false, canEditKnowledgeBase: true });
      const seedChat = async (userId: number, id: string, title: string, position: number, search = false, model = "gpt-5.5") => {
        const now = Date.now();
        const spaceId = randomUUID();
        const { doc, turns } = splitConversation({
          id, title, mode: "chat", model, providerId: "sub2api",
          createdAt: now, updatedAt: now, pinned: false, archived: false,
          ...(search ? {
            webSearch: true,
            environment: { kind: "space", spaceId } as const,
            cwd: path.join(state, "users", String(userId), "profile", "spaces", spaceId, "workspace"),
          } : {}),
          turns: [{
            id: randomUUID(), createdAt: now, status: "completed",
            prompt: title, attachments: [], items: [{
              id: randomUUID(), type: "agentMessage", text: "Synthetic project-move fixture.",
            }],
          }],
        });
        await web.request("store.conversations.put", userId, { doc, position });
        await web.request("store.turns.put", userId, { turns });
      };
      await seedChat(bob.id, bobConversation, "Bob private chat fixture", 0);
      if (projectMoveCua) {
        await seedChat(alice.id, randomUUID(), "Move this fixture chat", 0);
        await seedChat(alice.id, randomUUID(), "Keep this fixture chat here", 1, false, "gpt-5.4");
      }
      if (searchCua)
        await seedChat(alice.id, randomUUID(), "Search fixture chat", 0, true);
    }
    const keyAnswers: string[] = [];
    const uploadRows = new Map<string, { userId: number; info: { id: string; name: string; mime: string; size: number; received: number; complete: boolean; sha256?: string } }>();
    const uploadRequest = (userId: number, op: string, body: any) => {
      if (op === "begin") {
        const id = randomUUID();
        const info = { id, name: body.name, mime: body.mime, size: body.size, received: 0, complete: false };
        uploadRows.set(id, { userId, info });
        web.files.set(id, { userId, bytes: new Uint8Array() });
        return info;
      }
      const row = uploadRows.get(body.id), file = web.files.get(body.id);
      if (!row || !file || row.userId !== userId) throw Error("Unknown upload");
      if (op === "delete") {
        uploadRows.delete(body.id); web.files.delete(body.id); return {};
      }
      if (op === "write") {
        const bytes = Buffer.from(body.data, "base64");
        assert.equal(body.offset, file.bytes.byteLength);
        assert.ok(body.offset + bytes.length <= row.info.size);
        file.bytes = Buffer.concat([file.bytes, bytes]);
        row.info.received = file.bytes.byteLength;
        row.info.complete = row.info.received === row.info.size;
        if (row.info.complete) row.info.sha256 = createHash("sha256").update(file.bytes).digest("hex");
      } else assert.equal(op, "file");
      return row.info;
    };
    const driver = http.createServer((req, res) => {
      const body: Buffer[] = [];
      req.on("data", (chunk) => body.push(Buffer.from(chunk)));
      req.on("end", async () => {
        const input = JSON.parse(Buffer.concat(body).toString("utf8") || "{}");
        try {
          let value: unknown;
          if (req.url === "/store" && input.op === "store.projects.put" && cuaFaultFile &&
              fs.existsSync(cuaFaultFile) && fs.readFileSync(cuaFaultFile, "utf8").trim() === "project-save-failure")
            throw Error("Fixture project storage is unavailable.");
          if (req.url === "/store" && input.op === "store.settings.put" && cuaFaultFile &&
              fs.existsSync(cuaFaultFile) && fs.readFileSync(cuaFaultFile, "utf8").trim() === "model-preference-save-failure")
            throw Error("Fixture model preference storage is unavailable.");
          if (req.url === "/store")
            value = await web.request(input.op, input.userId, input.body);
          else if (req.url === "/upload")
            value = uploadRequest(input.userId, input.op, input.body);
          else {
            const deviceId =
              input.userId === alice.id
                ? "5f0e4a9e-7c55-4a47-8d1c-5b3c1c0d2e11"
                : "5f0e4a9e-7c55-4a47-8d1c-5b3c1c0d2e12";
            value = {
              deviceId,
              registration: await requestJson(
                fetch,
                `${mock.url}/api/v1/claudex/devices`,
                {
                  method: "POST",
                  token: tokens.get(input.userId)!,
                  deviceId,
                  body: deviceRegistrationBody({
                    deviceName: "Claudex on the web",
                    platform: "linux",
                    arch: "arm64",
                    appVersion: "0.0.1",
                    groupId: null,
                  }),
                },
              ),
            };
            keyAnswers.push(JSON.stringify(value));
          }
          res.end(JSON.stringify({ ok: true, value }));
        } catch (error) {
          res.end(
            JSON.stringify({
              ok: false,
              error: { message: (error as Error).message },
            }),
          );
        }
      });
    });
    await new Promise<void>((r) => driver.listen(0, "127.0.0.1", r));
    const driverUrl = `http://127.0.0.1:${(driver.address() as any).port}`;

    const runnerToken = "relay-smoke-runner-token-0123456789";
    const relay = spawn(
      relayBinary!,
      ["-mock", mock.url, "-driver", driverUrl, "-token", runnerToken],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let relayLog = "";
    relay.stderr!.on("data", (chunk) => (relayLog += chunk));
    const address = await new Promise<string>((resolve, reject) => {
      let out = "";
      relay.stdout!.on("data", (chunk) => {
        out += chunk;
        const match = /listening (\S+)/.exec(out);
        if (match) resolve(match[1]!);
      });
      relay.on("exit", () => reject(new Error(`relay exited: ${relayLog}`)));
    });
    const base = `http://${address}`;

    const startRunner = () => spawn(process.execPath, [path.join(outdir, "runner.mjs")], {
      env: {
        PATH: process.env.PATH,
        HOME: state,
        CLAUDEX_RUNNER_SERVICE_URL: base,
        CLAUDEX_RUNNER_TOKEN: runnerToken,
        CLAUDEX_RUNNER_DRIVER: "none",
        CLAUDEX_RUNNER_CODEX: codex!,
        CLAUDEX_RUNNER_STATE_DIR: state,
        CLAUDEX_RUNNER_OFFICIAL_UI_ROOT: path.resolve("build/official-ui"),
        CLAUDEX_RUNNER_OFFICIAL_UI_ACTIONS: "1",
        CLAUDEX_RUNNER_OFFICIAL_UI_MEMORY_CONTROLS: "1",
        CLAUDEX_RUNNER_OFFICIAL_UI_APPEARANCE_SETTINGS: "1",
        CLAUDEX_RUNNER_OFFICIAL_ACTION_DIAGNOSTICS: cuaFaultFile || process.env.CLAUDEX_E2E_OFFICIAL_ACTIONS === "1" ? "1" : "0",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let runner = startRunner();
    let runnerLog = "";
    runner.stderr!.on("data", (chunk) => {
      runnerLog += chunk;
      if (cuaFaultFile) process.stderr.write(chunk);
    });
    const until = async (check: () => boolean, what: string, ms = 60_000) => {
      const start = Date.now();
      while (!check()) {
        if (Date.now() - start > ms)
          throw new Error(
            `timed out waiting for ${what}\nrunner: ${runnerLog}\nrelay: ${relayLog}`,
          );
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const rpc = async (userId: number, method: string, ...args: unknown[]) => {
      const res = await fetch(`${base}${webPaths.rpc}${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens.get(userId)}`,
          "Content-Type": "application/json",
          "X-Claudex-Web-Tab": `tab-${userId}-000001`,
        },
        body: JSON.stringify({ args: encodeWireValue(args) }),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    const openTab = async (userId: number, tabId: string, lastSeq?: number) => {
      const res = await fetch(`${base}/api/v1/claudex/web/auth/events-ticket`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens.get(userId)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tabId }),
      });
      const ticket = ((await res.json()) as any).data.ticket;
      return new Tab(
        `ws://${address}${webPaths.events}`,
        ticket,
        tabId,
        lastSeq,
      );
    };
    const tabs: Tab[] = [];
    let browser: any;
    let restartActionBody: number[] | undefined;
    let officialFixture: Awaited<ReturnType<typeof officialBrowserFixture>> | undefined;
    try {
      // The runner links; calls wait for it.
      let snapshot: any;
      const start = Date.now();
      while (!snapshot) {
        const answer = await rpc(alice.id, "snapshot");
        if (answer.status === 200 && answer.body.ok)
          snapshot = answer.body.value;
        else if (Date.now() - start > 30_000)
          throw new Error(
            `no runner: ${JSON.stringify(answer)}\n${runnerLog}\n${relayLog}`,
          );
        else await new Promise((r) => setTimeout(r, 200));
      }
      assert.deepEqual(snapshot.settings.providers[0].models, ["gpt-5.5", "gpt-5.4"]);
      const usageAccountResult = await rpc(alice.id, "officialUiRead", { method: "GET", path: "/api/account" });
      const usageAccountReply = decodeWireValue(usageAccountResult.body.value) as OfficialUiReadResponse;
      assert.equal(usageAccountReply.status, 200);
      const usageAccount = JSON.parse(Buffer.from(usageAccountReply.body).toString());
      const usageOrg = usageAccount.claudex_usage_summary.organization_uuid;
      const usagePath = `/api/organizations/${usageOrg}/claudex_usage_activity`;
      const usageDay = (time: number) => new Intl.DateTimeFormat("en-CA", {year:"numeric",month:"2-digit",day:"2-digit"}).format(time);
      const usageQuery = new URLSearchParams({page:"1",pageSize:"10",start:usageDay(Date.now()-7*86400_000),end:usageDay(Date.now())});
      const usageRecordsResult = await rpc(alice.id, "officialUiRead", { method: "GET", path: `${usagePath}/records?${usageQuery}` });
      const usageRecordsReply = decodeWireValue(usageRecordsResult.body.value) as OfficialUiReadResponse;
      assert.equal(usageRecordsReply.status, 200, `${usagePath}/records?${usageQuery} ${Buffer.from(usageRecordsReply.body).toString()}`);
      const usageRecordsData = JSON.parse(Buffer.from(usageRecordsReply.body).toString());
      assert.equal(usageRecordsData.account_uuid, usageAccount.uuid);
      assert.equal(usageRecordsData.data.total, 15);
      assert.equal(usageRecordsData.data.items[0].cost, 0.0000128);
      assert.equal(usageRecordsData.data.items[2].cost, 0);
      const otherUsage = await rpc(bob.id, "officialUiRead", { method: "GET", path: `${usagePath}/records?${usageQuery}` });
      assert.equal((decodeWireValue(otherUsage.body.value) as OfficialUiReadResponse).status, 404);
      const directUsage = await rpc(alice.id, "usageRecords", { page: 1, pageSize: 10 });
      assert.equal(directUsage.body.error?.code, webErrorCodes.methodUnavailable);
      if (cuaFaultFile) {
        const official = async (user: number, method: string, request: object) => decodeWireValue((await rpc(user, method, request)).body.value) as OfficialUiReadResponse;
        const cap = await official(alice.id, "officialUiRead", {method:"GET",path:officialUiCapabilitiesPath});
        const lease = JSON.parse(Buffer.from(cap.body).toString()).activationLease;
        const modelPath = `/api/organizations/${usageOrg}/model_selector_state/chat`;
        const save = async (model: string | null, orgPath=modelPath) => official(alice.id,"officialUiAction",{method:"PATCH",path:orgPath,contentType:"application/json",body:Buffer.from(JSON.stringify({model})),capabilityLease:lease});
        assert.equal((await save("gpt-5.4")).status,200);
        assert.equal((web.users.get(alice.id)!.settings as any).officialModelPreferences.chat.model,"gpt-5.4");
        const foreignPreference = await save("gpt-5.5",`/api/organizations/${organizationUuid("foreign")}/model_selector_state/chat`);
        assert.equal(foreignPreference.status,404);
        assert.equal((await save(null)).status,200);
        assert.deepEqual((web.users.get(alice.id)!.settings as any).officialModelPreferences.chat,{});
        await serveOfficialWebForCua(base, cuaFaultFile);
        return;
      }

      const warmRegistry = registryFor(path.resolve("build/official-ui"));
      const warmSchema = warmRegistry.getMessage("anthropic.bard.api.v1alpha.PerformActionRequest")!;
      const warmResponse = warmRegistry.getMessage("anthropic.bard.api.v1alpha.PerformActionResponse")!;
      const capability = await rpc(alice.id, "officialUiRead", {
        method: "GET", path: officialUiCapabilitiesPath,
      });
      assert.equal(capability.body.ok, true);
      const capabilityReply = decodeWireValue(capability.body.value) as OfficialUiReadResponse;
      assert.equal(capabilityReply.status, 200);
      const { activationLease } = JSON.parse(Buffer.from(capabilityReply.body).toString());
      const warm = async (action: object, mutationId?: object) => {
        const answer = await rpc(alice.id, "officialUiAction", {
          method: "POST", path: officialUiActionPath, contentType: "application/proto", capabilityLease: activationLease,
          body: toBinary(warmSchema, deepCreate(warmSchema, {
            header: { conversationId: "99999999-9999-4999-8999-999999999999", source: 3, mutationId },
            action,
          })),
        });
        assert.equal(answer.body.ok, true);
        return decodeWireValue(answer.body.value) as OfficialUiReadResponse;
      };
      const beforeWarm = web.log.length;
      for (const value of [{}, { intendedSend: { text: "Warm hint with no send" } }]) {
        const result = await warm({ case: "warmTurn", value });
        assert.equal(result.status, 200, Buffer.from(result.body).toString());
        const { ack } = fromBinary(warmResponse, result.body) as any;
        assert.deepEqual(ack.outcome, { case: "applied", value: true });
        assert.equal(ack.highWaterMark, undefined);
      }
      assert.equal((await warm(
        { case: "warmTurn", value: {} }, { sessionId: "warm-does-not-mutate", version: 1n },
      )).status, 400);
      assert.equal((await warm({ case: "refreshConversation", value: {} })).status, 400);
      assert.equal(gatewayKeys.length, 0);
      assert.equal(web.users.get(alice.id)?.conversations.size, 0);
      assert.ok(!web.log.slice(beforeWarm).some(({ op }) => /^store\.(?:conversations|turns)\.(?:put|delete)/.test(op)));

      const tabA = await openTab(alice.id, "tab-alice-0001");
      const tabB = await openTab(bob.id, "tab-bob-00001");
      tabs.push(tabA, tabB);
      await until(() => tabA.of("ready").length === 1, "A ready");
      await until(() => tabB.of("ready").length === 1, "B ready");
      // Bob uses the web too (his own context on the same runner).
      const bobSnapshot = await rpc(bob.id, "snapshot");
      assert.equal(bobSnapshot.body.ok, true);

      const sent = await rpc(alice.id, "send", {
        text: "Say hello.",
        mode: "chat",
        attachments: [],
        providerId: snapshot.settings.activeProviderId,
        model: "gpt-5.5",
      });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      assert.equal(sent.body.ok, true, JSON.stringify(sent.body));
      const conversationId = sent.body.value.id;
      const completed = () =>
        tabA
          .of("event")
          .find(
            (f) =>
              f.event.type === "conversation" &&
              (f.event as any).conversation.id === conversationId &&
              (f.event as any).conversation.turns[0]?.status === "completed",
          );
      await until(() => !!completed(), "the turn over the events socket");
      const turn = (completed()!.event as any).conversation.turns[0];
      assert.match(JSON.stringify(turn.items), /Hello through the relay\./);
      const aliceAccount = decodeWireValue((await rpc(alice.id, "officialUiRead", { method: "GET", path: "/api/account" })).body.value) as { body: Uint8Array };
      const bobAccount = decodeWireValue((await rpc(bob.id, "officialUiRead", { method: "GET", path: "/api/account" })).body.value) as { body: Uint8Array };
      const aliceOrg = JSON.parse(Buffer.from(aliceAccount.body).toString("utf8")).memberships[0].organization.uuid;
      const bobOrg = JSON.parse(Buffer.from(bobAccount.body).toString("utf8")).memberships[0].organization.uuid;
      assert.notEqual(
        JSON.parse(Buffer.from(aliceAccount.body).toString()).uuid,
        accountFrom({ user: alice })!.id,
        "the original UI keeps its internal account identity",
      );
      for (const user of [alice, bob]) {
        for (const capabilityPath of [
          officialUiCapabilitiesPath,
          officialAppearanceCapabilitiesPath,
          officialMemoryCapabilitiesPath,
        ]) {
          const result = await rpc(user.id, "officialUiRead", {
            method: "GET",
            path: capabilityPath,
          });
          assert.equal(result.body.ok, true);
          const response = decodeWireValue(result.body.value) as {
            status: number;
            body: Uint8Array;
          };
          assert.equal(response.status, 200);
          const descriptor = JSON.parse(Buffer.from(response.body).toString());
          assert.equal(
            descriptor.accountId,
            accountFrom({ user })!.id,
            "runner capabilities must identify the authenticated Web account",
          );
        }
      }
      const browserTransport = new WebTransport({
        fetch: (input, init) => fetch(input instanceof Request ? input : new URL(String(input), base), init),
        timers: {
          setTimeout, setInterval,
          clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
          clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
        },
      }, {
        accessToken: async () => tokens.get(alice.id)!,
        refresh: async () => null,
        expire: () => assert.fail("The fixture account must remain signed in"),
      }, "project-context-integration");
      const appearanceCall = async (
        method: "officialUiRead" | "officialUiAction",
        request: OfficialUiReadRequest,
      ) => {
        return await browserTransport.call(method, await encodeCall([request], browserTransport)) as OfficialUiReadResponse;
      };
      let chatRequest: OfficialUiReadRequest | undefined;
      const sendChat = negotiatedOfficialAction({
        mode: "engine-chat",
        accountId: accountFrom({ user: alice })!.id,
        isCurrent: () => true,
        read: (request) => appearanceCall("officialUiRead", request),
        action: async (request) => {
          const response = await appearanceCall("officialUiAction", request);
          if (response.status === 200) chatRequest ??= request;
          return response;
        },
      });
      const registry = registryFor(path.resolve("build/official-ui"));
      const chatSchema = registry.getMessage("anthropic.bard.api.v1alpha.PerformActionRequest")!;
      const chatResponseSchema = registry.getMessage("anthropic.bard.api.v1alpha.PerformActionResponse")!;
      const chatAck = (reply: OfficialUiReadResponse) => {
        assert.equal(reply.status, 200, Buffer.from(reply.body).toString());
        return (fromBinary(chatResponseSchema, reply.body) as any).ack;
      };
      const chatBody = toBinary(chatSchema, deepCreate(chatSchema, {
        header: { conversationId, mutationId: { sessionId: "negotiated-relay-session", version: 1n } },
        action: { case: "sendMessage", value: {
          messageId: "33333333-3333-4333-8333-333333333333",
          assistantMessageId: "44444444-4444-4444-8444-444444444444",
          text: "NEGOTIATED_WEB_FOLLOWUP",
          chatMemoryMode: 1,
        } },
      }));
      const chatResponse = await sendChat({ method: "POST", path: officialUiActionPath,
        contentType: "application/proto", body: chatBody });
      assert.equal(chatAck(chatResponse).outcome.case, "applied");
      assert.ok(chatRequest?.capabilityLease, "the formal Web negotiator binds the send to the current activation");
      await until(() => tabA.of("event").some((frame) => {
        if (frame.event.type !== "conversation") return false;
        const conversation = (frame.event as any).conversation;
        return conversation.id === conversationId && conversation.turns.some((entry: any) =>
          entry.prompt === "NEGOTIATED_WEB_FOLLOWUP" && entry.status === "completed" &&
          JSON.stringify(entry.items).includes("Hello through the relay."));
      }), "the negotiated follow-up reply over the events socket");
      const chatSnapshot = decodeWireValue((await rpc(alice.id, "snapshot")).body.value) as any;
      const chatConversation = chatSnapshot.conversations.find((entry: any) => entry.id === conversationId);
      assert.equal(chatConversation.turns.length, 2, "the negotiated follow-up stays in the existing conversation");
      const metadataMutationId = "metadata-relay-session";
      const metadataRequest = (version: bigint, action: object, target = conversationId): OfficialUiReadRequest => ({
        method: "POST", path: officialUiActionPath, contentType: "application/proto",
        body: toBinary(chatSchema, deepCreate(chatSchema, {
          header: { conversationId: target, source: 3, displayLanguage: "en-US", mutationId: { sessionId: metadataMutationId, version } },
          action,
        })),
      });
      const rename = (title: string) => ({ case: "renameConversation", value: { title } });
      const star = (starred: boolean) => ({ case: "starConversation", value: { starred } });
      const readMetadata = async () => {
        const result = await appearanceCall("officialUiRead", {
          method: "GET", path: `/api/organizations/${aliceOrg}/chat_conversations/${conversationId}`,
        });
        assert.equal(result.status, 200);
        return JSON.parse(Buffer.from(result.body).toString());
      };
      const metadataTitle = "Renamed by the Web conversation header";
      const beforeMetadata = gatewayKeys.length;
      const renameRequest = metadataRequest(1n, rename(metadataTitle));
      const renamed = chatAck(await sendChat(renameRequest));
      assert.equal(renamed.outcome.case, "applied");
      assert.equal(renamed.highWaterMark.sessionId, metadataMutationId);
      assert.equal(renamed.highWaterMark.version, 1n);
      assert.deepEqual(chatAck(await sendChat(renameRequest)), renamed);
      assert.equal((await sendChat(metadataRequest(1n, rename("Different title")))).status, 409);
      assert.equal(chatAck(await sendChat(metadataRequest(2n, star(true)))).outcome.case, "applied");
      const starred = await readMetadata();
      assert.equal(starred.name, metadataTitle);
      assert.equal(starred.is_starred, true);
      assert.equal(chatAck(await sendChat(metadataRequest(3n, star(false)))).outcome.case, "applied");
      const invalidRename = chatAck(await sendChat(metadataRequest(4n, rename(" "))));
      assert.equal(invalidRename.outcome.case, "error");
      assert.equal(invalidRename.highWaterMark.version, 4n);
      const foreignRename = chatAck(await sendChat(metadataRequest(5n, rename("Foreign title"), bobConversation)));
      assert.equal(foreignRename.outcome.case, "error");
      assert.equal(foreignRename.outcome.value.action, "rename_conversation");
      assert.equal(foreignRename.highWaterMark.version, 5n);
      const unstarred = await readMetadata();
      assert.equal(unstarred.name, metadataTitle);
      assert.equal(unstarred.is_starred, false);
      assert.equal(gatewayKeys.length, beforeMetadata, "conversation metadata never requests a model");
      const comparePath = `/api/organizations/${aliceOrg}/chat_conversations`;
      const bootstrap = await appearanceCall("officialUiRead", { method: "GET", path: "/api/bootstrap" });
      assert.equal(bootstrap.status, 200);
      const compareBootstrap = JSON.parse(Buffer.from(bootstrap.body).toString());
      assert.equal(compareBootstrap.account.claudex_comparison_supported, true);
      assert.equal(compareBootstrap.org_growthbook.features["3082987388"].defaultValue, true);
      const comparePanels = [
        { uuid: randomUUID(), name: "Compare 1: COMPARE_TWO_ARMS", model: "gpt-5.5", compass_mode: null },
        { uuid: randomUUID(), name: "Compare 2: COMPARE_TWO_ARMS", model: "gpt-5.4", chat_memory_mode: "disabled" },
      ];
      const postChat = (path: string, input: object) => sendChat({
        method: "POST", path, contentType: "application/json",
        body: Buffer.from(JSON.stringify(input)),
      });
      const beforeCreate = gatewayKeys.length;
      assert.equal((await postChat(`/api/organizations/${bobOrg}/chat_conversations`, comparePanels[0])).status, 404);
      for (const [index, result] of (await Promise.all(comparePanels.map((panel) => postChat(comparePath, panel)))).entries()) {
        assert.equal(result.status, 200, Buffer.from(result.body).toString());
        const row = JSON.parse(Buffer.from(result.body).toString());
        assert.equal(row.uuid, comparePanels[index].uuid);
        assert.equal(row.chat_memory_mode, comparePanels[index].chat_memory_mode);
        assert.equal(row.current_leaf_message_uuid, null);
      }
      assert.equal((await postChat(comparePath, comparePanels[1])).status, 200);
      assert.equal((await postChat(comparePath, { ...comparePanels[1], name: "conflicting name" })).status, 409);
      assert.equal(gatewayKeys.length, beforeCreate, "explicit Compare creation does not call the model");
      const compareSnapshot = decodeWireValue((await rpc(alice.id, "snapshot")).body.value) as any;
      const spaces = comparePanels.map((panel) => {
        const row = compareSnapshot.conversations.find((entry: any) => entry.id === panel.uuid);
        assert.equal(row.turns.length, 0);
        assert.equal(row.environment.kind, "space");
        return row.environment.spaceId;
      });
      assert.notEqual(spaces[0], spaces[1]);
      let releaseCompare!: () => void;
      compareHold = new Promise((resolve) => { releaseCompare = resolve; });
      try {
        const requests = comparePanels.map((panel) => postChat(`${comparePath}/${panel.uuid}/completion`, {
          prompt: "COMPARE_TWO_ARMS",
          model: panel.model,
          thinking_mode: "off",
          rendering_mode: "messages",
          attachments: [],
          files: [],
          sync_sources: [],
          turn_message_uuids: { human_message_uuid: randomUUID(), assistant_message_uuid: randomUUID() },
        }));
        // Both real app-servers reach the gateway before either can finish.
        for (const result of await Promise.all(requests))
          assert.equal(result.status, 200, Buffer.from(result.body).toString());
        await until(() => compareRequests.length === 2, "both Compare arms concurrently at the gateway", 15_000);
        const on = compareRequests.find((request) => request.model === comparePanels[0].model);
        const off = compareRequests.find((request) => request.model === comparePanels[1].model);
        assert.ok(on && off, "each Compare arm sends through its selected model");
        assert.equal(JSON.stringify(on).includes("Alice's fixture memory."), true, "the enabled arm receives the account memory");
        assert.equal(/Alice's fixture memory\.|<user_memory/.test(JSON.stringify(off)), false, "the disabled arm does not receive account memory");
      } finally {
        releaseCompare();
        compareHold = undefined;
      }
      for (const panel of comparePanels) {
        await until(() => tabA.of("event").some((frame) =>
          frame.event.type === "conversation" && frame.event.conversation.id === panel.uuid &&
          frame.event.conversation.turns[0]?.status === "completed"), "the Compare reply");
      }
      const searchConversation = comparePanels[0].uuid;
      const readSearch = async () => {
        const result = await appearanceCall("officialUiRead", {
          method: "GET", path: `/api/organizations/${aliceOrg}/chat_conversations/${searchConversation}`,
        });
        assert.equal(result.status, 200);
        return JSON.parse(Buffer.from(result.body).toString()).settings.enabled_web_search;
      };
      const foreignSearch = chatAck(await sendChat(metadataRequest(6n, {
        case: "updateConversationSettings", value: { settings: { enabledWebSearch: true } },
      }, bobConversation)));
      assert.equal(foreignSearch.outcome.case, "error");
      const unrelatedSettings = await sendChat(metadataRequest(7n, {
        case: "updateConversationSettings", value: { settings: { enabledWebSearch: true, researchMode: 1 } },
      }, searchConversation));
      assert.equal(unrelatedSettings.status, 400);
      const unsupportedModel = chatAck(await sendChat(metadataRequest(8n, {
        case: "updateConversationSettings", value: { settings: { enabledWebSearch: true } },
      }, comparePanels[1].uuid)));
      assert.equal(unsupportedModel.outcome.case, "error");
      assert.match(unsupportedModel.outcome.value.error.displayMessage, /not available for this model/);
      assert.equal(await readSearch(), false);
      for (const enabled of [true, false]) {
        const before: number = gatewayKeys.length;
        const version = enabled ? 9n : 11n;
        const update = chatAck(await sendChat(metadataRequest(version, {
          case: "updateConversationSettings", value: { settings: { enabledWebSearch: enabled } },
        }, searchConversation)));
        assert.equal(update.outcome.case, "applied");
        assert.equal(update.highWaterMark.version, version);
        assert.equal(await readSearch(), enabled);
        assert.equal(web.users.get(alice.id)?.conversations.get(searchConversation)?.doc.conversation.webSearch, enabled);
        assert.equal(gatewayKeys.length, before, "changing web search does not request a model");
        const prompt = enabled ? searchResultPrompt : "RELAY_WEB_SEARCH_DISABLED";
        searchProbe = { prompt };
        const probe = chatAck(await sendChat(metadataRequest(version + 1n, {
          case: "sendMessage", value: { text: prompt, messageId: randomUUID(), assistantMessageId: randomUUID() },
        }, searchConversation)));
        assert.equal(probe.outcome.case, "applied");
        await until(() => tabA.of("event").some((frame) =>
          frame.event.type === "conversation" && frame.event.conversation.id === searchConversation &&
          frame.event.conversation.turns.some((turn) => turn.prompt === prompt && turn.status === "completed")), "the web search probe reply");
        assert.ok(searchProbe.toolTypes, "the probe reached the Responses gateway");
        assert.equal(searchProbe.toolTypes.some((type) => /^web_search(?:_|$)/.test(type)), enabled,
          `the actual Responses request follows the saved choice: ${JSON.stringify(searchProbe.toolTypes)}`);
        searchProbe = undefined;
      }
      const memoryOffId = randomUUID();
      const memoryOffSend = (id: string, version: bigint, prompt: string, existingOnly: boolean) =>
        sendChat({
          method: "POST",
          path: officialUiActionPath,
          contentType: "application/proto",
          body: toBinary(chatSchema, deepCreate(chatSchema, {
            header: {
              conversationId: id,
              existingOnly,
              mutationId: { sessionId: "memory-off-relay-session", version },
            },
            action: { case: "sendMessage", value: {
              messageId: randomUUID(),
              assistantMessageId: randomUUID(),
              text: prompt,
              chatMemoryMode: 2,
            } },
          })),
        });
      const beforeMismatch = gatewayKeys.length;
      const mismatch = chatAck(await memoryOffSend(conversationId, 1n, "Do not send this prompt.", true)).outcome;
      assert.equal(mismatch.case, "error");
      assert.match(mismatch.value.error.displayMessage, /set when starting a Chat/);
      assert.equal(gatewayKeys.length, beforeMismatch, "changing memory mode on an existing Chat never dispatches");
      const memoryOffTurn = (prompt: string) => tabA.of("event").some((frame) => {
        if (frame.event.type !== "conversation") return false;
        const conversation = frame.event.conversation;
        return conversation.id === memoryOffId && conversation.turns.some(
          (turn) => turn.prompt === prompt && turn.status === "completed",
        );
      });
      const firstMemoryOffPrompt = "Start a chat with memory off.";
      assert.equal(chatAck(await memoryOffSend(memoryOffId, 2n, firstMemoryOffPrompt, false)).outcome.case, "applied");
      await until(() => memoryOffTurn(firstMemoryOffPrompt), "the completed memory-off Chat");
      const nextMemoryOffPrompt = "Continue this chat with memory off.";
      assert.equal(chatAck(await memoryOffSend(memoryOffId, 3n, nextMemoryOffPrompt, true)).outcome.case, "applied");
      await until(() => memoryOffTurn(nextMemoryOffPrompt), "the memory-off follow-up");
      const moveTargets = await appearanceCall("officialUiRead", {
        method: "GET", path: `/api/organizations/${aliceOrg}/projects_v2?permission_filter=chat_create`,
      });
      assert.equal(moveTargets.status, 200);
      const moveRows = JSON.parse(Buffer.from(moveTargets.body).toString()).data;
      assert.ok(!moveRows.some((row: { uuid: string }) => row.uuid === bobProject));
      const moveTarget = moveRows.find((row: { uuid: string }) => row.uuid === aliceProject);
      assert.equal(moveTarget?.claudex_can_move_conversation, true);
      assert.equal(moveTarget?.claudex_can_edit_instructions, true);
      assert.equal(moveRows.find((row: { uuid: string }) => row.uuid === readOnlyProject)?.claudex_can_edit_instructions, false);
      assert.deepEqual(new Set(moveTarget.permissions), new Set(["chat_project:chat:view", "chat_project:knowledge:view", "chat_project:knowledge:edit", "chat_project:delete"]));
      const metadataProjectPath = `/api/organizations/${aliceOrg}/projects/${aliceProject}`;
      const updateProject = (path: string, body: object, contentType = "application/json"): OfficialUiReadRequest => ({
        method: "PUT", path, contentType, body: Buffer.from(JSON.stringify(body)),
      });
      const renamedProject = "Renamed in the Web project header";
      const editedDescription = "Edited together with the original project name";
      const beforeProjectActions = gatewayKeys.length;
      const createdInstructions = "中".repeat(100000);
      const creationId = randomUUID();
      const createProjectRequest: OfficialUiReadRequest = {
        method: "POST", path: `/api/organizations/${aliceOrg}/projects`, contentType: "application/json",
        body: Buffer.from('{"client_creation_id":"' + creationId + '","name":"Created through the Web","description":"Retained description","is_private":true,"is_starred":true,"prompt_template":"' + "\\u4e2d".repeat(100000) + '"}'),
      };
      const projectsBeforeCreate = web.users.get(alice.id)!.projects.size;
      assert.equal((await appearanceCall("officialUiAction", createProjectRequest)).status, 409);
      assert.equal((await sendChat({ ...createProjectRequest, path: `/api/organizations/${bobOrg}/projects` })).status, 404);
      web.failNext("store.projects.put");
      assert.equal((await sendChat(createProjectRequest)).status, 503);
      const createdProjectReply = await sendChat(createProjectRequest);
      assert.equal(createdProjectReply.status, 201, Buffer.from(createdProjectReply.body).toString());
      const createdProject = JSON.parse(Buffer.from(createdProjectReply.body).toString());
      assert.equal(createdProject.uuid, creationId);
      assert.equal((await sendChat(createProjectRequest)).status, 201);
      assert.equal(createdProject.is_starred, true);
      assert.ok(createdProject.prompt_template === createdInstructions, "created project retains all instruction characters");
      assert.equal(web.users.get(alice.id)!.projects.size, projectsBeforeCreate + 1);
      assert.ok(web.users.get(alice.id)!.projects.get(createdProject.uuid)!.project.instructions === createdInstructions, "the service stores the exact instructions");
      assert.equal(web.users.get(bob.id)?.projects.has(createdProject.uuid), false);
      const createdProjectPath = `/api/organizations/${aliceOrg}/projects/${createdProject.uuid}`;
      const projectContext = "项目初始资料,one\n".repeat(50000);
      const contextReply = await sendChat({
        method: "POST", path: createdProjectPath + "/docs", contentType: "application/json", acceptEncoding: "gzip",
        body: Buffer.from(JSON.stringify({ file_name: "initial-context.csv", content: projectContext })),
      });
      assert.equal(contextReply.status, 200, Buffer.from(contextReply.body).toString());
      assert.equal(contextReply.bodyEncoding, "gzip");
      const createdContext = JSON.parse(gunzipSync(contextReply.body).toString());
      assert.ok(createdContext.content === projectContext, "chunked project context preserves all UTF-8 bytes");
      const contextList = await appearanceCall("officialUiRead", { method: "GET", path: createdProjectPath + "/docs?compact=true" });
      assert.equal(contextList.status, 200);
      assert.deepEqual(JSON.parse(Buffer.from(contextList.body).toString()).map((doc: any) => [doc.uuid, doc.content]), [[createdContext.uuid, ""]]);
      assert.equal((await appearanceCall("officialUiAction", updateProject(metadataProjectPath, { name: renamedProject }))).status, 409);
      assert.equal((await sendChat(updateProject(metadataProjectPath, { description: 123 }))).status, 400);
      assert.equal((await sendChat(updateProject(metadataProjectPath, { is_starred: "true" }))).status, 400);
      assert.equal((await sendChat(updateProject(metadataProjectPath, { name: renamedProject }, "text/plain"))).status, 400);
      assert.equal((await sendChat(updateProject(metadataProjectPath.replace(aliceOrg, bobOrg), { name: renamedProject }))).status, 404);
      assert.equal((await sendChat(updateProject(metadataProjectPath.replace(aliceProject, bobProject), { is_starred: true }))).status, 404);
      const projectBefore = structuredClone(web.users.get(alice.id)!.projects.get(aliceProject)!.project);
      web.failNext("store.projects.put");
      assert.equal((await sendChat(updateProject(metadataProjectPath, {
        name: "Unconfirmed project name", description: "Unconfirmed description",
      }))).status, 503);
      const unchanged = await appearanceCall("officialUiRead", { method: "GET", path: metadataProjectPath });
      const unchangedProject = JSON.parse(Buffer.from(unchanged.body).toString());
      assert.equal(unchangedProject.name, projectBefore.name);
      assert.equal(unchangedProject.description, projectBefore.description);
      assert.deepEqual(web.users.get(alice.id)?.projects.get(aliceProject)?.project, projectBefore);

      for (const [payload, expected] of [
        [{ name: renamedProject, description: editedDescription }, { name: renamedProject, description: editedDescription }],
        [{ is_starred: true }, { pinned: true }],
        [{ is_starred: false }, { pinned: false }],
      ] as const) {
        const resyncsBefore = tabA.of("event").filter(frame => frame.event.type === "resync").length;
        const saved = await sendChat(updateProject(metadataProjectPath, payload));
        assert.equal(saved.status, 200, Buffer.from(saved.body).toString());
        assert.deepEqual(JSON.parse(Buffer.from(saved.body).toString()).permissions, moveTarget.permissions);
        Object.assign(projectBefore, expected);
        assert.deepEqual(web.users.get(alice.id)?.projects.get(aliceProject)?.project, projectBefore);
        await until(() => tabA.of("event").filter(frame => frame.event.type === "resync").length > resyncsBefore,
          "the other authenticated tab receives the saved project metadata update");
      }
      assert.equal(gatewayKeys.length, beforeProjectActions, "project metadata never requests a model");
      const projectMoveRequest = (ids: string[], project: string | null, org = aliceOrg) => ({
        method: "POST" as const,
        path: `/api/organizations/${org}/chat_conversations/move_many`,
        contentType: "application/json",
        body: new TextEncoder().encode(JSON.stringify({ conversation_uuids: ids, project_uuid: project })),
      });
      const noMoveLease = await appearanceCall("officialUiAction", projectMoveRequest([conversationId], aliceProject));
      assert.equal(noMoveLease.status, 409);
      const invalidMove = projectMoveRequest([conversationId], aliceProject);
      assert.equal((await sendChat({ ...invalidMove, contentType: "application/proto" })).status, 400);
      const moveQuery = await rpc(alice.id, "officialUiAction", {
        ...invalidMove, path: invalidMove.path + "?unexpected=1", capabilityLease: activationLease,
      });
      assert.equal(moveQuery.body.ok, false);
      assert.equal(web.users.get(alice.id)?.conversations.get(conversationId)?.doc.conversation.projectId, undefined);
      assert.equal((await sendChat(projectMoveRequest([conversationId], aliceProject, bobOrg))).status, 404);
      assert.equal((await sendChat(projectMoveRequest([conversationId], bobProject))).status, 404);
      const callsBeforeMove = gatewayKeys.length;
      // The installed client's legacy authenticated updateConversation call sends a scalar.
      for (const projectId of [aliceProject, null]) {
        const result = await rpc(alice.id, "updateConversation", conversationId, { projectId });
        assert.equal(result.status, 200);
        assert.equal(result.body.ok, true);
        await until(() => {
          const row = web.users.get(alice.id)?.conversations.get(conversationId)?.doc.conversation;
          return !!row && (row.projectId ?? null) === projectId;
        }, "legacy scalar project move read back from relay storage");
      }
      const moved = await sendChat(projectMoveRequest([conversationId, bobConversation, memoryOffId], aliceProject));
      assert.equal(moved.status, 200, Buffer.from(moved.body).toString());
      assert.deepEqual(JSON.parse(Buffer.from(moved.body).toString()), {
        moved: [conversationId, memoryOffId], failed: [bobConversation],
      });
      const unassigned = await sendChat(projectMoveRequest([conversationId], null));
      assert.equal(unassigned.status, 200, Buffer.from(unassigned.body).toString());
      assert.deepEqual(JSON.parse(Buffer.from(unassigned.body).toString()), {
        moved: [conversationId], failed: [],
      });
      assert.equal(gatewayKeys.length, callsBeforeMove, "project membership changes do not request a model");
      assert.equal(web.users.get(alice.id)?.conversations.get(memoryOffId)?.doc.conversation.projectId, aliceProject);
      assert.equal(web.users.get(bob.id)?.conversations.get(bobConversation)?.doc.conversation.projectId, undefined);
      assert.equal((await sendChat(updateProject(metadataProjectPath.replace(aliceProject, readOnlyProject), { prompt_template: "Unsupported" }))).status, 404);
      assert.equal((await sendChat(updateProject(metadataProjectPath, { prompt_template: "x".repeat(100_001) }))).status, 400);
      assert.equal((await sendChat(updateProject(metadataProjectPath, { prompt_template: "valid", description: "Unsupported" }))).status, 400);
      const instructionsPrompts = [
        "RELAY_PROJECT_INSTRUCTIONS_FIRST", "RELAY_PROJECT_INSTRUCTIONS_CHANGED", "RELAY_PROJECT_INSTRUCTIONS_CLEARED",
      ];
      const saveInstructions = async (instructions: string) => {
        const beforeWrite: number = gatewayKeys.length;
        const saved = await sendChat(updateProject(metadataProjectPath, { prompt_template: instructions }));
        assert.equal(saved.status, 200, Buffer.from(saved.body).toString());
        assert.equal(JSON.parse(Buffer.from(saved.body).toString()).prompt_template, instructions);
        assert.equal(web.users.get(alice.id)?.projects.get(aliceProject)?.project.instructions, instructions);
        assert.equal(gatewayKeys.length, beforeWrite, "saving instructions does not request a model");
      };
      const storedChat = async (id: string) => {
        const result = await rpc(alice.id, "snapshot");
        assert.equal(result.body.ok, true);
        const row = (decodeWireValue(result.body.value) as Snapshot).conversations.find((chat) => chat.id === id);
        assert.ok(row?.threadId);
        return row;
      };
      const expectInstructions = (prompt: string, a: boolean, b: boolean) => {
        assert.ok(instructionProbe?.contexts.length, `the current turn reached the Responses gateway: ${prompt}`);
        for (const context of instructionProbe.contexts)
          assert.deepEqual(context, { active: true, a, b }, `active project instructions for ${prompt}`);
        instructionProbe = undefined;
      };
      const originalThread = (await storedChat(memoryOffId)).threadId;
      const instructionValues = [`  ${projectInstructionA}\n中文项目说明\n`, projectInstructionB, ""];
      for (const [index, instructions] of instructionValues.entries()) {
        await saveInstructions(instructions);
        const prompt = instructionsPrompts[index];
        instructionProbe = { prompt, contexts: [] };
        const answer = chatAck(await memoryOffSend(memoryOffId, BigInt(index + 4), prompt, true));
        assert.equal(answer.outcome.case, "applied");
        await until(() => memoryOffTurn(prompt), "the project instructions probe reply");
        expectInstructions(prompt, index === 0, index === 1);
        assert.equal((await storedChat(memoryOffId)).threadId, originalThread);
      }
      const freshProjectChat = randomUUID();
      const freshProjectPrompts = ["RELAY_PROJECT_INSTRUCTIONS_FRESH", "RELAY_PROJECT_INSTRUCTIONS_FRESH_CLEARED"];
      let freshThread: string | undefined;
      for (const [index, prompt] of freshProjectPrompts.entries()) {
        await saveInstructions(index === 0 ? projectInstructionA : "");
        instructionProbe = { prompt, contexts: [] };
        const answer = await rpc(alice.id, "send", {
          mode: "chat", text: prompt, attachments: [], providerId: snapshot.settings.activeProviderId,
          model: "gpt-5.5", projectId: aliceProject,
          ...(index === 0 ? { newConversationId: freshProjectChat } : { conversationId: freshProjectChat }),
        });
        assert.equal(answer.body.ok, true, JSON.stringify(answer.body));
        assert.equal(answer.body.value.id, freshProjectChat);
        await until(() => tabA.of("event").some(({ event }) =>
          event.type === "conversation" && event.conversation.id === freshProjectChat &&
          event.conversation.turns.some((turn) => turn.prompt === prompt && turn.status === "completed")),
        "the fresh project Chat instructions probe reply");
        expectInstructions(prompt, index === 0, false);
        const stored = await storedChat(freshProjectChat);
        freshThread ??= stored.threadId;
        assert.equal(stored.threadId, freshThread);
        assert.deepEqual(stored.turns.map(({ prompt }) => prompt), freshProjectPrompts.slice(0, index + 1));
      }
      const foreignChat = await rpc(bob.id, "officialUiAction", chatRequest);
      assert.equal(foreignChat.body.ok, true);
      assert.equal((decodeWireValue(foreignChat.body.value) as OfficialUiReadResponse).status, 409);
      const failedPrompt = "NEGOTIATED_WEB_RETRY_SOURCE";
      const failedMessage = "55555555-5555-4555-8555-555555555555";
      const versionedChat = (version: bigint, value: object) => ({
        method: "POST" as const,
        path: officialUiActionPath,
        contentType: "application/proto",
        body: toBinary(chatSchema, deepCreate(chatSchema, {
          header: { conversationId, existingOnly: true, mutationId: { sessionId: "negotiated-relay-session", version } },
          action: { case: "sendMessage", value },
        })),
      });
      const turnEvent = (status: string) => tabA.of("event").some((frame) => {
        if (frame.event.type !== "conversation") return false;
        const conversation = frame.event.conversation as any;
        return conversation.id === conversationId && conversation.turns.some((turn: any) => turn.prompt === failedPrompt && turn.status === status);
      });
      failModel = true;
      try {
        const failed = await sendChat(versionedChat(2n, {
          messageId: failedMessage,
          assistantMessageId: "66666666-6666-4666-8666-666666666666",
          text: failedPrompt,
        }));
        assert.equal(failed.status, 200);
        await until(() => turnEvent("failed"), "the controlled model failure");
      } finally { failModel = false; }
      const timelineSchema = registry.getMessage("anthropic.bard.api.v1alpha.StreamTimelineRequest")!;
      const timeline = toBinary(timelineSchema, create(timelineSchema, { conversationId }));
      const envelope = Buffer.alloc(5);
      envelope.writeUInt32BE(timeline.length, 1);
      assert.equal((await appearanceCall("officialUiRead", {
        method: "POST", path: officialUiTimelinePath, contentType: "application/connect+proto",
        body: Buffer.concat([envelope, timeline]),
      })).status, 200);
      const retryFields = {
        inputMode: 2,
        chatMemoryMode: 1,
        parentMessageId: failedMessage,
        assistantMessageId: "77777777-7777-4777-8777-777777777777",
      };
      assert.equal((await sendChat(versionedChat(3n, { ...retryFields, text: "A retry cannot supply a new prompt." }))).status, 400);
      const beforeRetry = gatewayKeys.length;
      const retryRequest = versionedChat(3n, retryFields);
      for (const reply of await Promise.all([sendChat(retryRequest), sendChat(retryRequest)])) {
        const ack = chatAck(reply);
        assert.equal(ack.outcome.case, "applied", JSON.stringify(ack.outcome));
      }
      await until(() => turnEvent("completed"), "the retried response over the events socket");
      assert.equal(gatewayKeys.length, beforeRetry + 1, "duplicate delivery retries the original turn once");
      const changeAppearance = negotiatedAppearanceSettings({
        enabled: true,
        accountId: accountFrom({ user: alice })!.id,
        current: () => true,
        read: (request) => appearanceCall("officialUiRead", request),
        action: (request) => appearanceCall("officialUiAction", request),
      });
      const fontSave = await changeAppearance({
        method: "PATCH",
        path: "/api/account/settings",
        contentType: "application/json",
        body: new TextEncoder().encode(JSON.stringify({ chat_font: "dyslexia" })),
      });
      assert.equal(fontSave.status, 200, Buffer.from(fontSave.body).toString());
      const localeSave = await changeAppearance({
        method: "PUT",
        path: "/api/account_profile",
        contentType: "application/json",
        body: new TextEncoder().encode(JSON.stringify({ locale: "fr-FR" })),
      });
      assert.equal(localeSave.status, 200, Buffer.from(localeSave.body).toString());
      const aliceAfterFont = decodeWireValue(
        (await rpc(alice.id, "snapshot")).body.value,
      ) as any;
      const bobAfterFont = decodeWireValue((await rpc(bob.id, "snapshot")).body.value) as any;
      assert.equal(aliceAfterFont.settings.chatFont, "dyslexia");
      assert.equal(aliceAfterFont.settings.locale, "fr-FR");
      assert.notEqual(bobAfterFont.settings.chatFont, "dyslexia");
      assert.notEqual(bobAfterFont.settings.locale, "fr-FR");
      const alicePermission = await appearanceCall("officialUiRead", {
        method: "GET",
        path: officialAppearanceCapabilitiesPath,
      });
      const aliceLease = JSON.parse(
        Buffer.from(alicePermission.body).toString(),
      ).activationLease;
      const foreignWrite = await rpc(bob.id, "officialUiAction", {
        method: "PATCH",
        path: "/api/account/settings",
        contentType: "application/json",
        body: new TextEncoder().encode(JSON.stringify({ chat_font: "sans" })),
        capabilityLease: aliceLease,
      });
      assert.equal(foreignWrite.body.ok, true);
      assert.equal((decodeWireValue(foreignWrite.body.value) as any).status, 409);
      const memoryResult = await rpc(alice.id, "memoryStatus");
      assert.equal(memoryResult.body.ok, true, JSON.stringify(memoryResult.body));
      const memoryStatus = decodeWireValue(memoryResult.body.value) as { available: boolean; allowed: { generate: boolean; searchChats: boolean }; prefs: { generate: boolean; searchChats: boolean } };
      const memoryRead = await rpc(alice.id, "officialUiRead", { method: "GET", path: `/api/organizations/${aliceOrg}/memory/settings` });
      assert.equal(memoryRead.body.ok, true, JSON.stringify(memoryRead.body));
      const memoryResponse = decodeWireValue(memoryRead.body.value) as { status: number; body: Uint8Array };
      assert.equal(memoryResponse.status, 200);
      const officialMemory = JSON.parse(Buffer.from(memoryResponse.body).toString("utf8"));
      assert.equal(officialMemory.enabled_saffron, memoryStatus.available && memoryStatus.allowed.generate && memoryStatus.prefs.generate);
      assert.equal(officialMemory.enabled_saffron_search, memoryStatus.available && memoryStatus.allowed.searchChats && memoryStatus.prefs.searchChats);
      const memoryPath = (org: string) => `/api/organizations/${org}/memory`;
      const readMemory = async (userId: number, route: string) => {
        const result = await rpc(userId, "officialUiRead", { method: "GET", path: route });
        assert.equal(result.body.ok, true, JSON.stringify(result.body));
        const answer = decodeWireValue(result.body.value) as OfficialUiReadResponse;
        assert.equal(answer.status, 200, Buffer.from(answer.body).toString());
        return JSON.parse(Buffer.from(answer.body).toString());
      };
      const beforeMemory = await readMemory(alice.id, memoryPath(aliceOrg));
      assert.equal(beforeMemory.memory, "Alice's fixture memory.");
      assert.deepEqual(beforeMemory.controls, []);
      assert.deepEqual(
        (await readMemory(bob.id, officialMemoryCapabilitiesPath)).controls,
        { state: "denied", reason: "memory_off" },
      );
      let negotiatedMemoryRequest: OfficialUiReadRequest | undefined;
      const saveMemory = negotiatedMemoryAction({
        enabled: true,
        accountId: accountFrom({ user: alice })!.id,
        current: () => true,
        read: (request) => appearanceCall("officialUiRead", request),
        action: (request) => {
          negotiatedMemoryRequest = request;
          return appearanceCall("officialUiAction", request);
        },
      });
      const firstRules = ["Use concise examples."];
      const editMemory = (controls: string[], base_controls_version: string) => ({
        method: "PUT" as const,
        path: memoryPath(aliceOrg) + "/controls",
        contentType: "application/json",
        body: new TextEncoder().encode(JSON.stringify({ controls, base_controls_version })),
      });
      const beforeMemoryGatewayCalls = gatewayKeys.length;
      const savedMemory = await saveMemory(editMemory(firstRules, beforeMemory.controls_version));
      assert.equal(savedMemory.status, 200, Buffer.from(savedMemory.body).toString());
      assert.ok(negotiatedMemoryRequest?.capabilityLease);
      const afterFirstSave = await readMemory(alice.id, memoryPath(aliceOrg));
      assert.deepEqual(afterFirstSave.controls, firstRules);
      const externalRules = [...firstRules, "Preserve project terminology."];
      await requestJson(fetch, `${mock.url}/api/v1/claudex/memory/controls/global`, {
        token: tokens.get(alice.id)!,
        method: "PUT",
        body: { controls: externalRules, base_controls_version: afterFirstSave.controls_version },
      });
      const newRule = "Use tables when comparing options.";
      assert.equal((await saveMemory(editMemory([...firstRules, newRule], afterFirstSave.controls_version))).status, 409);
      const refreshedMemory = await readMemory(alice.id, memoryPath(aliceOrg));
      assert.deepEqual(refreshedMemory.controls, externalRules);
      assert.notEqual(refreshedMemory.controls_version, afterFirstSave.controls_version);
      const rules = [...externalRules, newRule];
      assert.equal((await saveMemory(editMemory(rules, refreshedMemory.controls_version))).status, 200);
      assert.deepEqual((await readMemory(alice.id, memoryPath(aliceOrg))).controls, rules);
      const otherMemory = await readMemory(bob.id, memoryPath(bobOrg));
      assert.equal(otherMemory.memory, "Bob's fixture memory.");
      assert.deepEqual(otherMemory.controls, []);
      assert.equal(gatewayKeys.length, beforeMemoryGatewayCalls, "manual rule saves do not request a model");
      const crossMemory = decodeWireValue((await rpc(bob.id, "officialUiRead", { method: "GET", path: `/api/organizations/${aliceOrg}/memory/settings` })).body.value) as { status: number };
      assert.equal(crossMemory.status, 404);
      const aliceBoot = await rpc(alice.id, "officialUiRead", { method: "GET", path: `/edge-api/bootstrap/${aliceOrg}/app_start` });
      assert.equal(aliceBoot.body.ok, true, JSON.stringify(aliceBoot.body));
      const bootResponse = decodeWireValue(aliceBoot.body.value) as { status: number; body: Uint8Array };
      assert.equal(bootResponse.status, 200);
      const bootText = Buffer.from(bootResponse.body).toString("utf8");
      const boot = JSON.parse(bootText);
      assert.equal(boot.account.email_address, alice.email);
      assert.equal(boot.org_growthbook.features["3903416871"].defaultValue.edit_resynthesize_enabled, true);
      assert.equal(bootText.includes(bob.email), false);
      const aOfficial = await rpc(alice.id, "officialUiRead", { method: "GET", path: `/api/organizations/${aliceOrg}/chat_conversations_v2` });
      assert.equal(aOfficial.body.ok, true, JSON.stringify(aOfficial.body));
      const aResponse = decodeWireValue(aOfficial.body.value) as { status: number; body: Uint8Array };
      assert.equal(aResponse.status, 200);
      assert.ok(JSON.parse(Buffer.from(aResponse.body).toString("utf8")).data.some((row: { uuid: string }) => row.uuid === conversationId));
      const bOfficial = await rpc(bob.id, "officialUiRead", { method: "GET", path: `/api/organizations/${bobOrg}/chat_conversations/${conversationId}` });
      assert.equal(bOfficial.body.ok, true, JSON.stringify(bOfficial.body));
      const bResponse = decodeWireValue(bOfficial.body.value) as { status: number };
      assert.equal(bResponse.status, 404, "Bob must not read Alice's official-UI conversation");
      if (process.env.CLAUDEX_E2E_CHROME && process.env.CLAUDEX_E2E_PLAYWRIGHT_ROOT) {
        const requirePlaywright = createRequire(path.join(process.env.CLAUDEX_E2E_PLAYWRIGHT_ROOT, "package.json"));
        const { chromium } = requirePlaywright("playwright-core");
        const bundle = await esbuild({ bundle: true, write: false, format: "iife", platform: "browser", stdin: {
          resolveDir: process.cwd(), loader: "js", contents: `
            import { WebTransport } from './shared/web-client/transport.ts';
            import { encodeCall } from './shared/web-client/codec.ts';
            import { eventsSubprotocols } from './shared/web-protocol.ts';
            import { createOfficialReadFetch } from './src-web/official/read-fetch.ts';
            window.__testOfficialFetch = (token, tabId, subscribe) => {
              const native = window.fetch.bind(window);
              const timers = { setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window), setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window) };
              const auth = { accessToken: async () => token, refresh: async () => null, expire() {} };
              const transport = new WebTransport({ fetch: native, timers }, auth, tabId);
              return createOfficialReadFetch(location.origin, async request => transport.call('officialUiRead', await encodeCall([request], transport)), native, subscribe,
                async request => transport.call('officialUiAction', await encodeCall([request], transport)));
            };
            window.__testEvents = async (ticket, tabId) => {
              const listeners = new Set();
              const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/v1/claudex/web/events', eventsSubprotocols(ticket));
              await new Promise((resolve, reject) => {
                socket.onerror = () => reject(Error('Event socket failed'));
                socket.onopen = () => socket.send(JSON.stringify({t:'hello', v:1, tabId}));
                socket.onmessage = message => {
                  const frame = JSON.parse(message.data);
                  if (frame.t === 'ready') resolve();
                  if (frame.t === 'event') for (const listener of listeners) listener(frame.event);
                };
              });
              return { subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, close: () => socket.close(), count: () => listeners.size };
            };`,
        } });
        browser = await chromium.launch({ executablePath: process.env.CLAUDEX_E2E_CHROME, headless: true });
        const pageA = await browser.newPage(), pageB = await browser.newPage();
        await Promise.all([pageA.goto(base), pageB.goto(base)]);
        await Promise.all([pageA.addScriptTag({ content: bundle.outputFiles[0].text }), pageB.addScriptTag({ content: bundle.outputFiles[0].text })]);
        const browserA = await pageA.evaluate(async ({ token, org }: any) => {
          const read = (window as any).__testOfficialFetch(token, "browser-a-0001");
          const response = await read(`/api/organizations/${org}/chat_conversations_v2`);
          return { status: response.status, body: await response.json() };
        }, { token: tokens.get(alice.id), org: aliceOrg });
        assert.equal(browserA.status, 200);
        assert.ok(browserA.body.data.some((row: { uuid: string }) => row.uuid === conversationId));
        const browserMemory = await pageA.evaluate(async ({ token, org }: any) => {
          const read = (window as any).__testOfficialFetch(token, "browser-a-0001");
          const response = await read(`/api/organizations/${org}/memory/settings`);
          return { status: response.status, body: await response.json() };
        }, { token: tokens.get(alice.id), org: aliceOrg });
        assert.equal(browserMemory.status, 200);
        assert.equal(browserMemory.body.enabled_saffron, officialMemory.enabled_saffron);
        assert.equal(browserMemory.body.enabled_saffron_search, officialMemory.enabled_saffron_search);
        const browserB = await pageB.evaluate(async ({ token, org, id }: any) => {
          const read = (window as any).__testOfficialFetch(token, "browser-b-0001");
          return (await read(`/api/organizations/${org}/chat_conversations/${id}`)).status;
        }, { token: tokens.get(bob.id), org: bobOrg, id: conversationId });
        assert.equal(browserB, 404, "the real browser must not cross account boundaries");
        const ticketResult = await fetch(`${base}/api/v1/claudex/web/auth/events-ticket`, { method: "POST",
          headers: { Authorization: `Bearer ${tokens.get(alice.id)}`, "Content-Type": "application/json" },
          body: JSON.stringify({ tabId: "browser-timeline-0001" }) });
        const ticket = ((await ticketResult.json()) as any).data.ticket;
        const schema = registryFor(path.resolve("build/official-ui")).getMessage("anthropic.bard.api.v1alpha.StreamTimelineRequest")!;
        const encoded = Buffer.from(toBinary(schema, create(schema, { conversationId })));
        const header = Buffer.alloc(5); header.writeUInt32BE(encoded.length, 1);
        const initialTimeline = await pageA.evaluate(async ({ token, ticket, body, timelinePath }: any) => {
          const events = await (window as any).__testEvents(ticket, "browser-timeline-0001");
          (window as any).__timelineEvents = events;
          const read = (window as any).__testOfficialFetch(token, "browser-timeline-0001", events.subscribe);
          const response = await read(timelinePath, { method: "POST", headers: { "content-type": "application/connect+proto" }, body: new Uint8Array(body) });
          if (response.status !== 200) throw Error(`Timeline returned ${response.status}`);
          const reader = response.body.getReader(); (window as any).__timelineReader = reader;
          return Array.from((await reader.read()).value);
        }, { token: tokens.get(alice.id), ticket, body: [...Buffer.concat([header, encoded])], timelinePath: officialUiTimelinePath });
        assert.ok(Buffer.from(initialTimeline).includes(Buffer.from("Hello through the relay.")));
        const rename = await rpc(alice.id, "updateConversation", conversationId, { title: "RELAY_TIMELINE_UPDATED" });
        assert.equal(rename.body.ok, true, JSON.stringify(rename.body));
        const updatedTimeline = await pageA.evaluate(async () => {
          const reader = (window as any).__timelineReader;
          return Array.from((await Promise.race([reader.read(), new Promise((_, reject) => setTimeout(() => reject(Error("Timeline update timed out")), 15000))])).value);
        });
        assert.ok(Buffer.from(updatedTimeline).includes(Buffer.from("RELAY_TIMELINE_UPDATED")));
        const actionSchema = registryFor(path.resolve("build/official-ui")).getMessage("anthropic.bard.api.v1alpha.PerformActionRequest")!;
        const actionBody = toBinary(actionSchema, deepCreate(actionSchema, {
          header: { conversationId, mutationId: { sessionId: "relay-test-session", version: 1n } },
          action: { case: "sendMessage", value: { messageId: "11111111-1111-4111-8111-111111111111",
            assistantMessageId: "22222222-2222-4222-8222-222222222222", text: "RELAY_OFFICIAL_SEND" } },
        }));
        restartActionBody = [...actionBody];
        const actionStatuses = await pageA.evaluate(async ({ token, body, actionPath }: any) => {
          const send = (window as any).__testOfficialFetch(token, "browser-timeline-0001", (window as any).__timelineEvents.subscribe);
          return Promise.all([
            send(actionPath, { method: "POST", headers: { "content-type": "application/proto" }, body: new Uint8Array(body) }),
            send(actionPath, { method: "POST", headers: { "content-type": "application/proto" }, body: new Uint8Array(body) }),
          ]).then(responses => responses.map(response => response.status));
        }, { token: tokens.get(alice.id), body: [...actionBody], actionPath: officialUiActionPath });
        assert.deepEqual(actionStatuses, [200, 200]);
        const sentFrame = await pageA.evaluate(async () => {
          const reader = (window as any).__timelineReader;
          const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(Error("Sent message did not reach timeline")), 15000));
          for (;;) {
            const value: any = await Promise.race([reader.read(), timeout]);
            const bytes = value.value as Uint8Array;
            if (new TextDecoder().decode(bytes).includes("RELAY_OFFICIAL_SEND")) return Array.from(bytes);
          }
        });
        assert.ok(Buffer.from(sentFrame).includes(Buffer.from("RELAY_OFFICIAL_SEND")));
        await until(() => tabA.of("event").some((frame) => JSON.stringify(frame.event).includes("RELAY_OFFICIAL_SEND")), "official send event");
        const latest = await rpc(alice.id, "snapshot");
        const saved = latest.body.value.conversations.find((entry: any) => entry.id === conversationId);
        assert.equal(saved.turns.filter((turn: any) => turn.prompt === "RELAY_OFFICIAL_SEND").length, 1);
        assert.equal(await pageA.evaluate(async () => { await (window as any).__timelineReader.cancel(); const events = (window as any).__timelineEvents; const count = events.count(); events.close(); return count; }), 0);
        if (process.env.CLAUDEX_E2E_OFFICIAL_RENDER === "1" || process.env.CLAUDEX_E2E_OFFICIAL_ACTIONS === "1") {
          officialFixture = await officialBrowserFixture(base, { actions: process.env.CLAUDEX_E2E_OFFICIAL_ACTIONS === "1" });
          const official = await browser.newPage();
          const failed: { path: string; status: number }[] = [];
          official.on("response", (response: any) => {
            const url = new URL(response.url());
            if (url.origin === officialFixture!.origin && response.status() >= 400) failed.push({ path: url.pathname, status: response.status() });
          });
          await official.route("**/*", (route: any) => {
            const url = new URL(route.request().url());
            return url.origin === officialFixture!.origin ? route.continue() : route.abort();
          });
          await official.addInitScript((token: string) => sessionStorage.setItem("__claudex_test_token", token), tokens.get(alice.id)!);
          await official.goto(`${officialFixture.origin}/new`);
          try { await official.locator('[contenteditable="true"],textarea').first().waitFor({ timeout: 45000 }); }
          catch (error) { throw Error(`Official Web composer did not load; failed requests: ${JSON.stringify(failed.slice(0, 30))}; ${error}`); }
          await official.waitForFunction(() => ((window as any).__officialTestCalls ?? []).some((call: { path: string }) => /\/projects$/.test(call.path)), null, { timeout: 15000 });
          await official.waitForTimeout(1500);
          assert.equal((await official.locator("body").innerText()).includes("This page ran into a problem"), false);
          if (process.env.CLAUDEX_E2E_OFFICIAL_ACTIONS === "1") {
            const prompt = "OFFICIAL_WEB_UI_SEND";
            try {
              await official.waitForFunction(() => (window as any).__officialTestStreamReady(), null, { timeout: 15_000 });
              const composer = official.locator('[contenteditable="true"],textarea').first();
              await composer.fill(prompt);
              await composer.press("Enter");
              await official.getByText("Hello through the relay.", { exact: false }).first().waitFor({ timeout: 15_000 });
              assert.ok((await official.evaluate(() => (window as any).__officialTestStreamEvents)).some((type: string) => type === "conversation" || type === "conversation-turn"), "the official page received no conversation events over WebSocket");
              assert.ok((await official.evaluate(() => (window as any).__officialTestCalls)).some((call: any) => call.path.endsWith("/PerformAction") && call.status === 200));
              const firstSnapshot = await rpc(alice.id, "snapshot");
              const firstConversation = firstSnapshot.body.value.conversations.find((entry: any) => entry.turns?.some((turn: any) => turn.prompt === prompt));
              assert.ok(firstConversation?.id);
              await until(() => [...(web.users.get(alice.id)?.turns.get(firstConversation.id)?.values() ?? [])]
                .some((row: TurnDoc) => row.turn.prompt === prompt && row.turn.status === "completed"), "official Web first turn completion");
              const next = official.locator('[contenteditable="true"],textarea').first();
              await next.fill("OFFICIAL_WEB_UI_FOLLOWUP");
              await next.press("Enter");
              await official.getByText("OFFICIAL_WEB_UI_FOLLOWUP", { exact: false }).first().waitFor({ timeout: 15_000 });
              await official.waitForFunction(() => (document.body.innerText.match(/Hello through the relay\./g) ?? []).length >= 2, null, { timeout: 15_000 });
            } catch (error) {
              const fields = runnerLog.split("\n").filter((line) => line.includes("[official-web] action field names"));
              throw Error(`Official Web text send did not complete; requests ${JSON.stringify(await official.evaluate(() => (window as any).__officialTestFailures))}; fields ${JSON.stringify(fields)}; ${error}`);
            } finally {
              const latest = await rpc(alice.id, "snapshot");
              const created = (latest.body.value?.conversations ?? []).find((entry: any) => entry.turns?.some((turn: any) => turn.prompt === prompt));
              if (created) await rpc(alice.id, "deleteConversation", created.id);
            }
          }
          const unsupported = await official.evaluate(() => (window as any).__officialTestFailures);
          if (process.env.CLAUDEX_E2E_OFFICIAL_DIAGNOSTICS === "1") console.log("Official Web unsupported requests:", JSON.stringify(unsupported));
          if (process.env.CLAUDEX_E2E_OFFICIAL_RENDER === "1") assert.deepEqual(unsupported, [], "the official Web page requested unavailable services");
        }
      }
      // Seq numbers follow each other.
      const seqs = tabA.of("event").map((f) => f.seq);
      seqs.forEach((seq, i) => i && assert.equal(seq, seqs[i - 1]! + 1));

      // Tenant isolation: none of Alice's events reached Bob's tab.
      assert.equal(
        JSON.stringify(tabB.frames).includes(conversationId),
        false,
        "Bob saw Alice's conversation",
      );
      // The model call used Alice's web key, which no browser frame carries.
      const key = mock.keys.find((k) => k.user_id === alice.id)!.key;
      assert.ok(gatewayKeys.length >= 1);
      assert.ok(gatewayKeys.every((value) => value === `Bearer ${key}`));
      assert.equal(JSON.stringify(tabA.frames).includes(key), false);
      assert.equal(JSON.stringify(sent.body).includes(key), false);
      // The turn reached the store for Alice only.
      await until(
        () =>
          [
            ...(web.users.get(alice.id)?.turns.get(conversationId)?.values() ??
              []),
          ].some((row: TurnDoc) => row.turn.status === "completed"),
        "the stored turn",
      );
      assert.equal(web.users.get(bob.id)?.turns.get(conversationId), undefined);

      // Resume: a reconnect with the last seq gets a resumed ready.
      const last = tabA.of("event").at(-1)!.seq;
      tabA.close();
      const again = await openTab(alice.id, "tab-alice-0001", last);
      tabs.push(again);
      await until(() => again.of("ready").length === 1, "resumed ready");
      assert.equal(again.of("ready")[0]!.resumed, true);

      // An artifact preview through the signed, sandboxed proxy.
      const preview = await rpc(
        alice.id,
        "createArtifactPreview",
        "<!doctype html><p>preview body</p>",
      );
      assert.equal(preview.body.ok, true, JSON.stringify(preview.body));
      const url: string = preview.body.value;
      assert.match(
        url,
        /^\/api\/v1\/claudex\/web\/preview\/41\.[0-9a-f-]+\?k=/,
      );
      const page = await fetch(`${base}${url}`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /preview body/);
      assert.match(
        page.headers.get("content-security-policy") ?? "",
        /sandbox allow-scripts.*frame-ancestors 'self'/,
      );
      // Bob cannot read Alice's preview without its signature.
      const bare = await fetch(`${base}${url.split("?")[0]}`);
      assert.equal(bare.status, 404);
      runner.kill("SIGTERM");
      await new Promise((resolve) => runner.once("exit", resolve));
      runner = startRunner();
      runner.stderr!.on("data", (chunk) => (runnerLog += chunk));
      const deadline = Date.now() + 30_000;
      for (;;) {
        const result = await rpc(alice.id, "snapshot").catch(() => null);
        if (result?.body.ok) {
          assert.equal(
            (decodeWireValue(result.body.value) as any).settings.chatFont,
            "dyslexia",
          );
          assert.equal((decodeWireValue(result.body.value) as any).settings.locale, "fr-FR");
          break;
        }
        if (Date.now() > deadline) throw Error("The test runner did not reconnect.");
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const expiredChat = await rpc(alice.id, "officialUiAction", chatRequest);
      assert.equal(expiredChat.body.ok, true);
      assert.equal((decodeWireValue(expiredChat.body.value) as OfficialUiReadResponse).status, 409);
      const restoredChat = decodeWireValue((await rpc(alice.id, "snapshot")).body.value) as any;
      const restoredMetadata = await readMetadata();
      const restoredProject = await appearanceCall("officialUiRead", { method: "GET", path: metadataProjectPath });
      const restoredCreatedProject = await appearanceCall("officialUiRead", { method: "GET", path: `/api/organizations/${aliceOrg}/projects/${createdProject.uuid}` });
      assert.equal(restoredCreatedProject.status, 200);
      const createdAfterRestart = JSON.parse(Buffer.from(restoredCreatedProject.body).toString());
      assert.equal(createdAfterRestart.name, "Created through the Web");
      assert.equal(createdAfterRestart.is_starred, true);
      assert.equal(createdAfterRestart.description, "Retained description");
      assert.ok(createdAfterRestart.prompt_template === createdInstructions, "instructions survive runner restart exactly");
      const restoredContext = await appearanceCall("officialUiRead", {
        method: "GET", path: createdProjectPath + "/docs/" + createdContext.uuid, acceptEncoding: "gzip",
      });
      assert.equal(restoredContext.status, 200);
      assert.equal(restoredContext.bodyEncoding, "gzip");
      assert.ok(JSON.parse(gunzipSync(restoredContext.body).toString()).content === projectContext, "initial project context survives runner restart exactly");
      assert.equal((await sendChat({ method: "DELETE", path: createdProjectPath + "/docs/" + createdContext.uuid })).status, 204);
      assert.equal((await appearanceCall("officialUiRead", { method: "GET", path: createdProjectPath + "/docs/" + createdContext.uuid })).status, 404);
      assert.equal(restoredProject.status, 200);
      assert.equal(JSON.parse(Buffer.from(restoredProject.body).toString()).name, renamedProject);
      assert.equal(JSON.parse(Buffer.from(restoredProject.body).toString()).description, editedDescription);
      assert.equal(JSON.parse(Buffer.from(restoredProject.body).toString()).is_starred, false);
      assert.equal(JSON.parse(Buffer.from(restoredProject.body).toString()).prompt_template, "");
      assert.equal(restoredMetadata.name, metadataTitle);
      assert.equal(restoredMetadata.is_starred, false);
      assert.equal(restoredChat.conversations.find((entry: any) => entry.id === conversationId)
        .turns.filter((entry: any) => entry.prompt === "NEGOTIATED_WEB_FOLLOWUP").length, 1);
      const restoredMemoryOff = restoredChat.conversations.find((entry: any) => entry.id === memoryOffId);
      assert.equal(restoredMemoryOff.memoryDisabled, true);
      assert.equal(restoredMemoryOff.threadId, originalThread);
      assert.equal(restoredMemoryOff.projectId, aliceProject);
      assert.equal(!!restoredMemoryOff.incognito, false);
      assert.deepEqual(
        restoredMemoryOff.turns.map((turn: any) => turn.prompt),
        [firstMemoryOffPrompt, nextMemoryOffPrompt, ...instructionsPrompts],
      );
      const restoredFreshProject = await storedChat(freshProjectChat);
      assert.equal(restoredFreshProject.threadId, freshThread);
      assert.deepEqual(restoredFreshProject.turns.map(({ prompt }) => prompt), freshProjectPrompts);
      const memoryOffDetail = await appearanceCall("officialUiRead", {
        method: "GET",
        path: `/api/organizations/${aliceOrg}/chat_conversations/${memoryOffId}`,
      });
      assert.equal(memoryOffDetail.status, 200);
      const memoryOffMetadata = JSON.parse(Buffer.from(memoryOffDetail.body).toString());
      assert.equal(memoryOffMetadata.chat_memory_mode, "disabled");
      assert.equal(memoryOffMetadata.project_uuid, aliceProject);
      assert.equal(restoredChat.conversations.find((entry: any) => entry.id === conversationId).projectId, undefined);
      const timelineResponse = registry.getMessage("anthropic.bard.api.v1alpha.StreamTimelineResponse")!;
      const readTimelineAfterRestart = async (id: string) => {
        const payload = toBinary(timelineSchema, create(timelineSchema, { conversationId: id }));
        const envelope = Buffer.alloc(5);
        envelope.writeUInt32BE(payload.length, 1);
        const answer = await appearanceCall("officialUiRead", {
          method: "POST", path: officialUiTimelinePath, contentType: "application/connect+proto",
          body: Buffer.concat([envelope, payload]),
        });
        assert.equal(answer.status, 200);
        const update = (fromBinary(timelineResponse, answer.body.subarray(5)) as any).event.event;
        assert.equal(update.case, "update");
        return update.value;
      };
      const memoryOffUpdate = await readTimelineAfterRestart(memoryOffId);
      assert.equal(memoryOffUpdate.conversation.settings.chatMemoryMode, 2);
      const searchTimeline = await readTimelineAfterRestart(searchConversation);
      const searchRows = searchTimeline.contentBlocks.filter((block: any) => block.rowKind === 7);
      assert.deepEqual(searchRows.map((row: any) => [row.inputSummary, row.state]), [
        ["Fixture search with a source", 2], ["Fixture search with no results", 2], ["Fixture search failure", 3],
      ]);
      const results = searchRows[0].displayContent.content;
      assert.equal(results.case, "richItems");
      assert.deepEqual(results.value.items.map(({ title, url }: any) => [title, url]), [["Fixture source page", searchSourceUrl]]);
      assert.equal(searchRows[1].displayContent, undefined);
      assert.equal(searchRows[2].displayContent, undefined);
      const cited = searchTimeline.contentBlocks.find((block: any) => block.text === "🔎 Search evidence from the fixture.");
      assert.deepEqual(cited.citations.map(({ startIndex, endIndex, url }: any) => [startIndex, endIndex, url]), [[2, 17, searchSourceUrl]]);
      assert.equal(Array.from(cited.text).slice(2, 17).join(""), "Search evidence");
      const expiredPermission = await rpc(alice.id, "officialUiAction", {
        method: "PATCH",
        path: "/api/account/settings",
        contentType: "application/json",
        body: new TextEncoder().encode(JSON.stringify({ chat_font: "sans" })),
        capabilityLease: aliceLease,
      });
      assert.equal(expiredPermission.body.ok, true);
      assert.equal((decodeWireValue(expiredPermission.body.value) as any).status, 409);
      const memoryReady = await rpc(alice.id, "memoryStatus");
      assert.equal(memoryReady.body.ok, true);
      assert.deepEqual((await readMemory(alice.id, memoryPath(aliceOrg))).controls, rules);
      const expiredMemory = await rpc(alice.id, "officialUiAction", negotiatedMemoryRequest);
      assert.equal(expiredMemory.body.ok, true);
      assert.equal((decodeWireValue(expiredMemory.body.value) as OfficialUiReadResponse).status, 409);
      if (restartActionBody && browser) {
        const page = browser.contexts()[0].pages()[0];
        const status = await page.evaluate(async ({ token, body, actionPath }: any) => {
          const send = (window as any).__testOfficialFetch(token, "browser-timeline-0001");
          return (await send(actionPath, { method: "POST", headers: { "content-type": "application/proto" }, body: new Uint8Array(body) })).status;
        }, { token: tokens.get(alice.id), body: restartActionBody, actionPath: officialUiActionPath });
        assert.equal(status, 200);
        const afterRestart = await rpc(alice.id, "snapshot");
        const saved = afterRestart.body.value.conversations.find((entry: any) => entry.id === conversationId);
        assert.equal(saved.turns.filter((turn: any) => turn.prompt === "RELAY_OFFICIAL_SEND").length, 1);
      }
      const deleteProjectRequest: OfficialUiReadRequest = { method: "DELETE", path: metadataProjectPath };
      web.failNext("store.projects.delete");
      assert.equal((await sendChat(deleteProjectRequest)).status, 503);
      assert.equal((await appearanceCall("officialUiRead", { method: "GET", path: metadataProjectPath })).status, 200);
      const aliceRows = web.users.get(alice.id)!;
      assert.ok(aliceRows.projects.has(aliceProject));
      assert.ok(aliceRows.conversations.has(freshProjectChat));
      assert.ok(aliceRows.conversations.has(memoryOffId));
      const deletedProject = await sendChat(deleteProjectRequest);
      assert.equal(deletedProject.status, 204, Buffer.from(deletedProject.body).toString());
      assert.equal(deletedProject.body.byteLength, 0);
      assert.equal((await appearanceCall("officialUiRead", { method: "GET", path: metadataProjectPath })).status, 404);
      assert.equal(aliceRows.projects.has(aliceProject), false);
      for (const id of [freshProjectChat, memoryOffId]) {
        assert.equal(aliceRows.conversations.has(id), false);
        assert.equal((await appearanceCall("officialUiRead", { method: "GET", path: `${comparePath}/${id}` })).status, 404);
      }
      assert.ok(aliceRows.conversations.has(conversationId));
      assert.ok(web.users.get(bob.id)?.projects.has(bobProject));
    } finally {
      if (browser) await browser.close();
      officialFixture?.close();
      for (const tab of tabs) tab.close();
      if (runner.exitCode === null) { runner.kill("SIGTERM"); await new Promise((r) => runner.once("exit", r)); }
      relay.kill("SIGTERM");
      await mock.close();
      driver.close();
      fs.rmSync(outdir, { recursive: true, force: true });
      fs.rmSync(state, { recursive: true, force: true });
      for (const dir of loginDirs) fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
