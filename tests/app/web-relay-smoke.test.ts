/**
 * End-to-end smoke of the web relay: the Go relay
 * (backend/backend/internal/claudex/webhost, run by its relaysmoke command)
 * between a browser client (this test: RPC over HTTP, the events WebSocket with
 * a ticket in Sec-WebSocket-Protocol) and the real runner bundle, which links
 * to the relay as the local runner and runs a real codex app-server against the
 * Sub2API mock's gateway.
 *
 * The relay's backends that other packages own are answered by this test:
 * webstore ops (the runner-core in-memory webstore) and key.get (a device
 * registration at the mock). Everything else the runner asks the service
 * (Sub2API user calls, /v1) goes through the relay to the mock.
 *
 * Skipped unless CLAUDEX_RELAY_SMOKE_BIN names a relaysmoke binary for this
 * machine and codex exists.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import {
  eventsSubprotocols,
  parseServerFrame,
  webPaths,
  type ServerFrame,
} from "../../shared/web-protocol";
import { type TurnDoc } from "../../shared/web-docs";
import { deviceRegistrationBody } from "../../shared/claudex-contract";
import { requestJson } from "../../electron/sub2api/http";
import { RemoteAccounts } from "../../electron/sub2api/identity";
import { resolveRuntime } from "../../electron/engine/runtime";
import { MockSub2Api, fakeCipher } from "../support/sub2api-mock";
import { memoryWebstore } from "../runner/runner-core-support.test.ts";

const relayBinary = process.env.CLAUDEX_RELAY_SMOKE_BIN;
function codexBinary() {
  if (process.env.CLAUDEX_E2E_CODEX) return process.env.CLAUDEX_E2E_CODEX;
  try {
    return resolveRuntime();
  } catch {
    return undefined;
  }
}
const codex = codexBinary();

function sse(text: string) {
  const id = `msg_${Date.now()}`;
  const item = {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const response = {
    id: `resp_${Date.now()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: "gpt-5.5",
    output: [item],
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
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: id,
      content_index: 0,
      delta: text,
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  return Buffer.from(
    events
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
    timeout: 180_000,
  },
  async () => {
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-smoke-dist-"));
    execFileSync(
      process.execPath,
      ["scripts/build-runner.mjs", "--outdir", outdir],
      { stdio: "ignore" },
    );
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
          name: "pro",
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
      models: { status: 200, body: { data: [{ id: "gpt-5.5" }] } },
    });
    const gatewayKeys: string[] = [];
    mock.route("POST", "/v1/responses", (request) => {
      gatewayKeys.push(String(request.headers.authorization));
      return {
        status: 200,
        body: sse("Hello through the relay."),
        headers: { "Content-Type": "text/event-stream" },
      };
    });
    await mock.start();
    const signIn = async (user: typeof alice) => {
      const result = await new RemoteAccounts(
        fs.mkdtempSync(path.join(os.tmpdir(), "relay-smoke-login-")),
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
    const keyAnswers: string[] = [];
    const driver = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        const input = JSON.parse(body || "{}");
        try {
          let value: unknown;
          if (req.url === "/store")
            value = await web.request(input.op, input.userId, input.body);
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

    const state = fs.mkdtempSync(path.join(os.tmpdir(), "relay-smoke-state-"));
    const runner = spawn(process.execPath, [path.join(outdir, "runner.mjs")], {
      env: {
        PATH: process.env.PATH,
        HOME: state,
        CLAUDEX_RUNNER_SERVICE_URL: base,
        CLAUDEX_RUNNER_TOKEN: runnerToken,
        CLAUDEX_RUNNER_DRIVER: "none",
        CLAUDEX_RUNNER_CODEX: codex!,
        CLAUDEX_RUNNER_STATE_DIR: state,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let runnerLog = "";
    runner.stderr!.on("data", (chunk) => (runnerLog += chunk));
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
        body: JSON.stringify({ args }),
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
      assert.deepEqual(snapshot.settings.providers[0].models, ["gpt-5.5"]);

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
    } finally {
      for (const tab of tabs) tab.close();
      runner.kill("SIGTERM");
      await new Promise((r) => runner.once("exit", r));
      relay.kill("SIGTERM");
      await mock.close();
      driver.close();
      fs.rmSync(outdir, { recursive: true, force: true });
    }
  },
);
