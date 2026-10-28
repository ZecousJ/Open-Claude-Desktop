/**
 * The built runner end to end: a fake Go (link, webstore, web key) in front
 * of the Claudex service mock, the runner bundle as its own process, and a
 * real codex app-server answering one Chat turn through the runner's
 * provider service and the mock gateway.
 *
 * Needs the codex executable (the @openai/codex dev dependency, or
 * CLAUDEX_E2E_CODEX); skipped without it. CLAUDEX_E2E_DRIVER=bwrap runs codex
 * in the bubblewrap sandbox (Linux; see the W-RUNNER report for the Docker
 * command); the default runs it unsandboxed, as in development.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import {
  parseRunnerFrame,
  type RunnerFrame,
} from "../../shared/web-runner-frames";
import { type TurnDoc } from "../../shared/web-docs";
import { deviceRegistrationBody } from "../../shared/claudex-contract";
import { requestJson } from "../../electron/sub2api/http";
import { RemoteAccounts } from "../../electron/sub2api/identity";
import { resolveRuntime } from "../../electron/engine/runtime";
import { MockSub2Api, fakeCipher } from "../support/sub2api-mock";
import {
  acceptWebSockets,
  memoryWebstore,
} from "./runner-core-support.test.ts";

function codexBinary() {
  if (process.env.CLAUDEX_E2E_CODEX) return process.env.CLAUDEX_E2E_CODEX;
  try {
    return resolveRuntime();
  } catch {
    return undefined;
  }
}
const codex = codexBinary();

/** The Responses stream of one assistant message. */
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
      type: "response.content_part.added",
      output_index: 0,
      item_id: id,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: id,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      output_index: 0,
      item_id: id,
      content_index: 0,
      text,
    },
    {
      type: "response.content_part.done",
      output_index: 0,
      item_id: id,
      content_index: 0,
      part: item.content[0],
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

test(
  "one Chat turn through the built runner",
  { skip: codex ? false : "no codex executable", timeout: 120_000 },
  async () => {
    // A prebuilt runner (CLAUDEX_E2E_DIST, e.g. in a Linux container), or a fresh build.
    const prebuilt = process.env.CLAUDEX_E2E_DIST;
    const outdir =
      prebuilt ?? fs.mkdtempSync(path.join(os.tmpdir(), "runner-e2e-dist-"));
    if (!prebuilt)
      execFileSync(
        process.execPath,
        ["scripts/build-runner.mjs", "--outdir", outdir],
        { stdio: "ignore" },
      );
    const user = {
      id: 41,
      email: "eve@example.test",
      password: "eve-password-1",
      username: "Eve",
    };
    const mock = new MockSub2Api({
      users: [user],
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
        body: sse("Hello from the mock gateway."),
        headers: { "Content-Type": "text/event-stream" },
      };
    });
    await mock.start();
    const signIn = await new RemoteAccounts(
      fs.mkdtempSync(path.join(os.tmpdir(), "runner-e2e-login-")),
      mock.url,
      fakeCipher,
    ).login(user.email, user.password);
    if (signIn.kind !== "signedIn") throw new Error("sign-in");
    const token = await signIn.session.authorized(async (t) => t);

    // Go's side of the link.
    const web = memoryWebstore(50);
    const frames: RunnerFrame[] = [];
    let send: (frame: object) => void = () => {};
    const webDeviceId = "5f0e4a9e-7c55-4a47-8d1c-5b3c1c0d2e11";
    const linkSockets = acceptWebSockets((mock as any).server, (socket) => {
      send = (frame) => socket.send(JSON.stringify(frame));
      socket.onText = async (text) => {
        const frame = parseRunnerFrame(text);
        frames.push(frame);
        if (process.env.CLAUDEX_E2E_DEBUG) console.error("runner →", text);
        if (frame.t === "hello")
          send({ t: "welcome", v: 1, runnerId: "e2e", heartbeatMs: 25000 });
        if (frame.t === "request") {
          try {
            const value =
              frame.op === "key.get"
                ? {
                    deviceId: webDeviceId,
                    registration: await requestJson(
                      fetch,
                      `${mock.url}/api/v1/claudex/devices`,
                      {
                        method: "POST",
                        token,
                        deviceId: webDeviceId,
                        body: deviceRegistrationBody({
                          deviceName: "Claudex on the web",
                          platform: "linux",
                          arch: "arm64",
                          appVersion: "0.0.1",
                          groupId: null,
                        }),
                      },
                    ),
                  }
                : await web.request(frame.op, frame.userId!, frame.body);
            send({ t: "response", id: frame.id, ok: true, value });
          } catch (error) {
            send({
              t: "response",
              id: frame.id,
              ok: false,
              error: { message: (error as Error).message },
            });
          }
        }
      };
    });

    const state = fs.mkdtempSync(path.join(os.tmpdir(), "runner-e2e-state-"));
    const child = spawn(process.execPath, [path.join(outdir, "runner.mjs")], {
      env: {
        PATH: process.env.PATH,
        HOME: state,
        CLAUDEX_RUNNER_SERVICE_URL: mock.url,
        CLAUDEX_RUNNER_TOKEN: "runner-token-0123456789",
        CLAUDEX_RUNNER_DRIVER: process.env.CLAUDEX_E2E_DRIVER ?? "none",
        CLAUDEX_RUNNER_CODEX: codex!,
        ...(process.env.CLAUDEX_E2E_CODEX_ROOT
          ? { CLAUDEX_RUNNER_CODEX_ROOT: process.env.CLAUDEX_E2E_CODEX_ROOT }
          : {}),
        ...(process.env.CLAUDEX_E2E_PATH_DIRS
          ? { CLAUDEX_RUNNER_PATH_DIRS: process.env.CLAUDEX_E2E_PATH_DIRS }
          : {}),
        CLAUDEX_RUNNER_STATE_DIR: state,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    const until = async (check: () => boolean, what: string, ms = 60_000) => {
      const start = Date.now();
      while (!check()) {
        if (Date.now() - start > ms)
          throw new Error(`timed out waiting for ${what}; runner: ${stderr}`);
        if (child.exitCode !== null)
          throw new Error(`runner exited: ${stderr}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    let next = 0;
    const call = async (method: string, ...args: unknown[]) => {
      const id = `e2e-${++next}`;
      send({
        t: "call",
        id,
        user: { id: user.id, accessToken: token, tabId: "tab-e2e-0001" },
        method,
        args,
        deadlineMs: 60_000,
      });
      await until(
        () => frames.some((f) => f.t === "result" && f.id === id),
        method,
      );
      const result = frames.find(
        (f) => f.t === "result" && f.id === id,
      ) as Extract<RunnerFrame, { t: "result" }>;
      assert.equal(result.ok, true, `${method}: ${result.error?.message}`);
      return result.value as any;
    };
    try {
      await until(() => frames.some((f) => f.t === "hello"), "hello");
      const snapshot = await call("snapshot");
      assert.deepEqual(snapshot.settings.providers[0].models, ["gpt-5.5"]);
      const conversation = await call("send", {
        text: "Say hello.",
        mode: "chat",
        attachments: [],
        providerId: snapshot.settings.activeProviderId,
        model: "gpt-5.5",
      });
      const done = () =>
        frames.find(
          (f) =>
            f.t === "event" &&
            f.event.type === "conversation" &&
            f.event.conversation.id === conversation.id &&
            f.event.conversation.turns[0]?.status === "completed",
        ) as Extract<RunnerFrame, { t: "event" }> | undefined;
      await until(() => !!done(), "the turn to complete");
      const turn = (done()!.event as any).conversation.turns[0];
      assert.match(JSON.stringify(turn.items), /Hello from the mock gateway\./);
      // The model was called with the user's web key, never anything else.
      const key = mock.keys.find((k) => k.user_id === user.id)!.key;
      assert.ok(gatewayKeys.length >= 1);
      assert.ok(gatewayKeys.every((value) => value === `Bearer ${key}`));
      // The turn reached webstore.
      await until(
        () =>
          [
            ...(web.users.get(user.id)?.turns.get(conversation.id)?.values() ??
              []),
          ].some((row: TurnDoc) => row.turn.status === "completed"),
        "the stored turn",
      );
      // No frame carries the key.
      assert.equal(JSON.stringify(frames).includes(key), false);
      assert.equal(JSON.stringify(web.log).includes(key), false);
    } finally {
      const exited =
        child.exitCode !== null
          ? Promise.resolve(child.exitCode)
          : new Promise<number | null>((resolve) =>
              child.on("exit", (code) => resolve(code)),
            );
      child.kill("SIGTERM");
      const code = await exited;
      for (const socket of linkSockets) socket.destroy();
      await mock.close();
      if (!prebuilt) fs.rmSync(outdir, { recursive: true, force: true });
      assert.equal(code, 0, stderr);
    }
  },
);
