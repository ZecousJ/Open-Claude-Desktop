/** Real bundled Codex + loopback model; reproduces TTTT's response.failed without paid calls. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { build } from "esbuild";
import { Engine } from "../electron/engine/engine";
import { Store } from "../electron/store/store";
import { resolveRuntime } from "../electron/engine/runtime";
type Json = Record<string, any>;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-stream-recovery-"));
const resources = process.env.CLAUDEX_RECOVERY_RESOURCES;
const service = resources
  ? path.join(resources, "provider-service/provider-service.cjs")
  : path.join(root, "provider-service.cjs");
const markerFile = path.join(root, "tool-once.txt");
const model = "gpt-5.2-codex";
const activeTools = {
  "active-tool-reset": makeToolFiles("reset"),
  "active-tool-stop": makeToolFiles("stop"),
};
function makeToolFiles(kind: string) {
  return {
    release: path.join(root, kind + "-release"),
    calls: ["a", "b"].map((name) => ({
      id: "call_" + kind + "_" + name,
      started: path.join(root, kind + "-started-" + name),
      finished: path.join(root, kind + "-finished-" + name),
    })),
  };
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => boolean, label: string, ms = 35000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw Error("Timed out: " + label);
    await sleep(20);
  }
}
let scenario = "recover",
  attempts = 0,
  requestNumber = 0;
let handlerError: unknown;
let activeStop: { closed: boolean } | undefined;
let partialVisible = false;
const requests: Json[] = [];
const exhaustedAttempts: number[] = [];
const flatten = (tools: Json[], namespace?: string): Json[] =>
  tools.flatMap((t) =>
    t.type === "namespace"
      ? flatten(t.tools ?? [], t.name)
      : [{ ...t, namespace }],
  );
function event(res: http.ServerResponse, type: string, rest: Json = {}) {
  res.write(
    "event: " +
      type +
      String.fromCharCode(10) +
      "data: " +
      JSON.stringify({ type, ...rest }) +
      String.fromCharCode(10, 10),
  );
}
function beginResponse(res: http.ServerResponse, id: string) {
  event(res, "response.created", {
    response: { id, model, status: "in_progress", output: [] },
  });
}
function sendOutput(res: http.ServerResponse, output: Json[]) {
  for (const [index, item] of output.entries()) {
    event(res, "response.output_item.added", {
      output_index: index,
      item: {
        ...item,
        status: "in_progress",
        ...(item.type === "message" ? { content: [] } : { arguments: "" }),
      },
    });
    if (item.type === "message")
      event(res, "response.output_text.delta", {
        output_index: index,
        item_id: item.id,
        content_index: 0,
        delta: item.content[0].text,
      });
    else
      event(res, "response.function_call_arguments.delta", {
        output_index: index,
        item_id: item.id,
        delta: item.arguments,
      });
    event(res, "response.output_item.done", { output_index: index, item });
  }
}
function success(res: http.ServerResponse, output: Json[]) {
  const id = "resp_" + requestNumber;
  beginResponse(res, id);
  sendOutput(res, output);
  event(res, "response.completed", {
    response: {
      id,
      model,
      status: "completed",
      output,
      usage: { input_tokens: 30, output_tokens: 8, total_tokens: 38 },
    },
  });
  res.end();
}
function shellCall(body: Json, id: string, command: string, waitMs = 10000) {
  const tool = flatten(body.tools).find((t) =>
    ["exec_command", "shell_command"].some(
      (n) => t.name === n || t.name?.endsWith("__" + n),
    ),
  );
  assert.ok(tool, "native shell tool present");
  const args = tool.name.endsWith("shell_command")
    ? { command, timeout_ms: waitMs + 5000 }
    : {
        cmd: command,
        login: false,
        max_output_tokens: 100,
        yield_time_ms: waitMs,
      };
  return {
    id: "fc_" + id,
    type: "function_call",
    call_id: id,
    name: tool.name,
    ...(tool.namespace ? { namespace: tool.namespace } : {}),
    arguments: JSON.stringify(args),
    status: "completed",
  };
}
const message = (text: string) => ({
  id: "msg_" + requestNumber,
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});
const server = http.createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body.tools?.length) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      success(res, [message("AUXILIARY")]);
      return;
    }
    requests.push(body);
    requestNumber++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (
      scenario === "tool" &&
      !body.input.some(
        (i: Json) =>
          i.type === "function_call_output" && i.call_id === "call_once",
      )
    ) {
      success(res, [
        shellCall(
          body,
          "call_once",
          "printf x >> " + JSON.stringify(markerFile),
        ),
      ]);
      return;
    }
    if (scenario === "active-tool-reset" || scenario === "active-tool-stop") {
      const fixture = activeTools[scenario];
      const long = scenario === "active-tool-reset" && process.env.CLAUDEX_LONG_RECOVERY_TEST === "1";
      const outputs = body.input.filter(
        (i: Json) => i.type === "function_call_output",
      );
      if (outputs.length) {
        assert.equal(scenario, "active-tool-reset");
        for (const output of outputs)
          assert.match(String(output.output), long ? /Process running with session ID/ : /F161_TOOL_FINISHED/);
        assert.deepEqual(
          outputs.map((i: Json) => i.call_id).sort(),
          fixture.calls.map((call) => call.id).sort(),
        );
        if (long)
          await until(() => fixture.calls.every(call => fs.existsSync(call.finished)), "long tools finish");
        success(res, [message("STREAM_RECOVERED_OK")]);
        return;
      }
      const calls = fixture.calls.map(({ id, started, finished }) =>
        shellCall(
          body,
          id,
          "printf x >> " +
            JSON.stringify(started) +
            "; for i in $(seq 1 900); do test -f " +
            JSON.stringify(fixture.release) +
            " && { printf x >> " +
            JSON.stringify(finished) +
            "; printf F161_TOOL_FINISHED; exit; }; sleep 0.1; done; exit 1",
          long ? 80_000 : undefined,
        ),
      );
      assert.equal(body.parallel_tool_calls, true);
      beginResponse(res, "resp_" + requestNumber);
      sendOutput(res, calls);
      await until(
        () => fixture.calls.every((call) => fs.existsSync(call.started)),
        "both tools running",
      );
      assert.ok(fixture.calls.every((call) => !fs.existsSync(call.finished)));
      if (long) await sleep(65_000);
      if (scenario === "active-tool-stop") {
        const stopped = { closed: false };
        activeStop = stopped;
        res.on("close", () => {
          stopped.closed = true;
        });
        return;
      }
      assert.ok(res.socket);
      res.on("close", () => fs.writeFileSync(fixture.release, ""));
      res.socket.resetAndDestroy();
      return;
    }
    attempts++;
    if (scenario === "exhaust") exhaustedAttempts.push(performance.now());
    if (scenario === "fatal") {
      event(res, "response.failed", {
        response: {
          id: "resp_fatal",
          status: "failed",
          error: {
            code: "context_length_exceeded",
            message: "Input exceeds the context window.",
          },
        },
      });
      res.end();
      return;
    }
    if (
      (["recover", "tool", "rate", "eof", "socket-reset"].includes(scenario) &&
        attempts > 1) ||
      (scenario === "delayed-recovery" && attempts === 4)
    ) {
      success(res, [message("STREAM_RECOVERED_OK")]);
      return;
    }
    event(res, "response.created", {
      response: {
        id: "resp_failed_" + requestNumber,
        status: "in_progress",
        model,
        output: [],
      },
    });
    event(res, "response.output_item.added", {
      output_index: 0,
      item: {
        id: "partial_" + requestNumber,
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    });
    event(res, "response.output_text.delta", {
      output_index: 0,
      item_id: "partial_" + requestNumber,
      content_index: 0,
      delta: "PARTIAL_BEFORE_DROP",
    });
    if (scenario === "socket-reset") {
      await until(
        () => partialVisible,
        "partial text visible before socket reset",
      );
      assert.ok(res.socket);
      res.socket.resetAndDestroy();
      return;
    }
    if (scenario === "eof") {
      res.end();
      return;
    }
    const error =
      scenario === "rate"
        ? {
            code: "rate_limit_exceeded",
            type: "rate_limit_error",
            message: "Upstream rate limit exceeded, please retry later",
          }
        : {
            code: "server_error",
            type: "server_error",
            message: "Upstream response interrupted. Please retry.",
          };
    event(res, "response.failed", {
      sequence_number: 53,
      response: {
        id: "resp_failed_" + requestNumber,
        status: "failed",
        model,
        error,
      },
    });
    res.end();
  } catch (error) {
    handlerError = error;
    res.end();
  }
});
let engine: Engine | undefined;
let store: Store | undefined;
const reconnects: string[] = [];
const turn = (id: string) => store!.conversation(id).turns.at(-1)!;
async function run(kind: string, mode: "chat" | "code" | "cowork" = "code") {
  scenario = kind;
  attempts = 0;
  partialVisible = false;
  const c = await engine!.send({
    mode,
    text: "STREAM_RECOVERY_" + kind,
    attachments: [],
    providerId: "mock",
    model,
    cwd: root,
  });
  return c.id;
}
async function settled(id: string) {
  await until(
    () => turn(id).status !== "inProgress" || !!handlerError,
    "turn " + scenario,
    scenario === "active-tool-reset" && process.env.CLAUDEX_LONG_RECOVERY_TEST === "1"
      ? 100_000
      : undefined,
  );
  if (handlerError) throw handlerError;
  return turn(id);
}
try {
  if (!resources)
    await build({
      entryPoints: ["server/provider-service.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      outfile: service,
      logLevel: "error",
    });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  store = new Store(root);
  store.settings.providers = [
    {
      id: "mock",
      name: "Loopback",
      baseUrl: "http://127.0.0.1:" + (server.address() as any).port + "/v1",
      protocol: "responses",
      model,
      models: [model],
    },
  ];
  store.settings.activeProviderId = "mock";
  store.settings.codeSandbox = "workspace-write";
  engine = new Engine(
    store,
    resolveRuntime(resources),
    () => "loopback-test-key",
    (e) => {
      if (e.type === "approval")
        void engine!.approve(e.approval.id, { decision: "accept" });
      if (e.type !== "conversation") return;
      const t = e.conversation.turns.at(-1);
      if (!t) return;
      if (t.reconnecting) reconnects.push(String(t.reconnecting));
      if (
        scenario === "socket-reset" &&
        t.items.some(
          (i) =>
            i.type === "agentMessage" &&
            i.text?.includes("PARTIAL_BEFORE_DROP"),
        )
      )
        partialVisible = true;
    },
    service,
  );
  engine.sessionAssistance.afterTurn = async () => {};
  engine.titleOffers.afterTurn = async () => {};
  const first = await run("recover");
  const recovered = await settled(first);
  if (process.env.CLAUDEX_EXPECT_NO_STREAM_RETRY === "1") {
    assert.equal(recovered.status, "failed");
    assert.equal(attempts, 1);
    console.log(
      JSON.stringify({
        result: "baseline-reproduced",
        attempts,
        error: recovered.error,
        completedAt: new Date().toISOString(),
      }),
    );
  } else {
    assert.equal(recovered.status, "completed", recovered.error);
    assert.equal(attempts, 2);
    assert.ok(reconnects.length);
    assert.equal(store.conversation(first).turns.length, 1);
    assert.equal(
      recovered.items.filter(
        (i) =>
          i.type === "agentMessage" && i.text?.includes("STREAM_RECOVERED_OK"),
      ).length,
      1,
    );
    console.log(
      "PASS transient stream error recovers inside one turn, one final answer",
    );
    for (const failure of ["rate", "eof", "socket-reset"]) {
      const id = await run(failure);
      const turn = await settled(id);
      assert.equal(turn.status, "completed", turn.error);
      assert.equal(attempts, 2);
      assert.equal(store.conversation(id).turns.length, 1);
      assert.deepEqual(
        turn.items.filter((i) => i.type === "agentMessage").map((i) => i.text),
        ["STREAM_RECOVERED_OK"],
      );
      console.log("PASS " + failure + " recovers with bounded native retry");
    }
    for (const mode of ["chat", "cowork"] as const) {
      const id = await run("recover", mode);
      assert.equal((await settled(id)).status, "completed");
      assert.equal(attempts, 2);
      console.log("PASS " + mode + " recovers inside the existing turn");
    }
    const withTool = await run("tool");
    assert.equal((await settled(withTool)).status, "completed");
    assert.equal(fs.readFileSync(markerFile, "utf8"), "x");
    assert.equal(attempts, 2);
    console.log(
      "PASS completed shell tool executes exactly once across recovery",
    );
    const startActiveReset = requests.length;
    const reconnectStart = reconnects.length;
    const resetId = await run("active-tool-reset");
    const resetTurn = await settled(resetId);
    assert.equal(resetTurn.status, "completed", resetTurn.error);
    assert.equal(store.conversation(resetId).turns.length, 1);
    assert.equal(requests.length - startActiveReset, 2);
    assert.ok(reconnects.slice(reconnectStart).includes("1/5"));
    assert.equal(
      resetTurn.items.filter(
        (i) =>
          i.type === "commandExecution" && i.lifecycleStatus === "completed",
      ).length,
      2,
    );
    assert.deepEqual(
      resetTurn.items
        .filter((i) => i.type === "agentMessage")
        .map((i) => i.text),
      ["STREAM_RECOVERED_OK"],
    );
    for (const { started, finished } of activeTools["active-tool-reset"]
      .calls) {
      assert.equal(fs.readFileSync(started, "utf8"), "x");
      assert.equal(fs.readFileSync(finished, "utf8"), "x");
    }
    console.log(
      "PASS two active shell tools complete exactly once after socket reset",
    );
    const delayed = await run("delayed-recovery", "chat");
    assert.equal((await settled(delayed)).status, "completed");
    assert.equal(attempts, 4);
    assert.equal(store.conversation(delayed).turns.length, 1);
    console.log("PASS Chat recovers after three consecutive stream failures");
    const exhausted = await run("exhaust");
    assert.equal((await settled(exhausted)).status, "failed");
    assert.equal(attempts, 6);
    const delays = exhaustedAttempts.slice(1).map((time, index) =>
      Math.round(time - exhaustedAttempts[index]));
    console.log("Native stream retry intervals (ms):", delays.join(", "));
    assert.equal(delays.length, 5);
    assert.ok(delays[4] > delays[0] && delays[4] >= 1_000, delays.join(", "));
    console.log("PASS repeated failure backs off and stops after five retries");
    const fatal = await run("fatal");
    assert.equal((await settled(fatal)).status, "failed");
    assert.equal(attempts, 1);
    console.log("PASS fatal context error is not retried");
    const stop = await run("stop");
    await until(() => !!turn(stop).reconnecting, "reconnecting");
    await engine.interrupt(stop);
    await settled(stop);
    const count = attempts;
    await sleep(2000);
    assert.equal(attempts, count);
    assert.equal(turn(stop).status, "interrupted");
    console.log("PASS user Stop cancels retry and prevents later requests");
    const startActiveStop = requests.length;
    const stopId = await run("active-tool-stop");
    await until(
      () => !!activeStop || !!handlerError,
      "both tools running with upstream open",
    );
    if (handlerError) throw handlerError;
    await engine.interrupt(stopId);
    assert.equal((await settled(stopId)).status, "interrupted");
    await until(
      () => activeStop?.closed === true,
      "upstream connection closed",
    );
    const stopFixture = activeTools["active-tool-stop"];
    fs.writeFileSync(stopFixture.release, "");
    await sleep(2000);
    assert.equal(requests.length - startActiveStop, 1);
    for (const { started, finished } of stopFixture.calls) {
      assert.equal(fs.readFileSync(started, "utf8"), "x");
      assert.equal(fs.existsSync(finished), false);
    }
    console.log(
      "PASS user Stop cancels both active shell tools and their upstream stream",
    );
    console.log(
      JSON.stringify({
        result: "passed",
        completedAt: new Date().toISOString(),
        engineVersion: engine.state.version,
        runtimeSource: resources ?? "repository dependency",
        scope:
          "bundled engine/local model: stream error and socket reset recovery, concurrent tools exactly once, retry bound, fatal refusal and Stop; no paid requests",
      }),
    );
  }
} finally {
  await engine?.stop();
  store?.flush();
  server.closeAllConnections();
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
