/**
 * Spike harness: the real bundled Codex app-server against a loopback
 * Responses fixture. Isolated CODEX_HOME per run, no user credentials, no
 * paid requests. Used only by tests/spikes/*.spike.ts (not part of npm test).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { CodexRPC } from "../../electron/engine/rpc";
import { resolveRuntime } from "../../electron/engine/runtime";

export type Json = Record<string, any>;
export const MODEL = "gpt-5.2-codex";
export const FAKE_KEY = "spike-key-not-a-real-credential";

export const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function until(
  predicate: () => boolean,
  label: string,
  ms = 30_000,
) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error(`Timed out: ${label}`);
    await delay(25);
  }
}

export function flattenTools(tools: Json[] = [], namespace?: string): Json[] {
  return tools.flatMap((tool) =>
    tool.type === "namespace"
      ? flattenTools(tool.tools ?? [], tool.name)
      : [{ ...tool, namespace }],
  );
}

/** Every tool name the request advertises, namespaced as `ns/name`. */
export function toolNames(body: Json): string[] {
  return flattenTools(body.tools).map((t) =>
    t.namespace ? `${t.namespace}/${t.name ?? t.type}` : (t.name ?? t.type),
  );
}

export function findTool(body: Json, match: (name: string) => boolean) {
  return flattenTools(body.tools).find((t) => t.name && match(t.name));
}

export function historyText(body: Json): string {
  return JSON.stringify([body.instructions ?? "", body.input ?? []]);
}

export function functionCall(tool: Json, callId: string, args: Json): Json {
  return {
    id: `fc_${callId}`,
    type: "function_call",
    call_id: callId,
    name: tool.name,
    ...(tool.namespace ? { namespace: tool.namespace } : {}),
    arguments: JSON.stringify(args),
    status: "completed",
  };
}

export function message(text: string, id = "msg_" + Date.now()): Json {
  return {
    id,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

function responseEvents(output: Json[], responseId: string, model: string) {
  let sequence = 0;
  const events: Json[] = [];
  const add = (event: Json) =>
    events.push({ ...event, sequence_number: sequence++ });
  const response = {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output,
    usage: {
      input_tokens: 30,
      output_tokens: 8,
      total_tokens: 38,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  add({
    type: "response.created",
    response: { ...response, status: "in_progress", output: [] },
  });
  output.forEach((item, i) => {
    add({
      type: "response.output_item.added",
      output_index: i,
      item: {
        ...item,
        status: "in_progress",
        ...(item.type === "message"
          ? { content: [] }
          : item.type === "function_call"
            ? { arguments: "" }
            : {}),
      },
    });
    if (item.type === "message") {
      const part = item.content[0];
      add({
        type: "response.content_part.added",
        output_index: i,
        item_id: item.id,
        content_index: 0,
        part: { ...part, text: "" },
      });
      add({
        type: "response.output_text.delta",
        output_index: i,
        item_id: item.id,
        content_index: 0,
        delta: part.text,
      });
      add({
        type: "response.output_text.done",
        output_index: i,
        item_id: item.id,
        content_index: 0,
        text: part.text,
      });
      add({
        type: "response.content_part.done",
        output_index: i,
        item_id: item.id,
        content_index: 0,
        part,
      });
    } else if (item.type === "function_call") {
      add({
        type: "response.function_call_arguments.delta",
        output_index: i,
        item_id: item.id,
        delta: item.arguments,
      });
      add({
        type: "response.function_call_arguments.done",
        output_index: i,
        item_id: item.id,
        arguments: item.arguments,
      });
    }
    add({ type: "response.output_item.done", output_index: i, item });
  });
  add({ type: "response.completed", response });
  return events;
}

/** Decides the fixture model's reply; returns the output items. */
export type Script = (body: Json, index: number) => Json[] | Promise<Json[]>;

export class MockResponses {
  requests: Json[] = [];
  script: Script = () => [message("ok")];
  private server = http.createServer((req, res) => this.handle(req, res));
  url = "";
  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}/v1`;
    return this;
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      if (req.headers.authorization !== `Bearer ${FAKE_KEY}`) {
        res.writeHead(401).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      if (req.url !== "/v1/responses") {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const index = this.requests.push(body) - 1;
      const output = await this.script(body, index);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of responseEvents(output, `resp_${index}`, MODEL))
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  }
  /** Upstream requests Codex sent for one thread. */
  forThread(threadId: string) {
    return this.requests.filter(
      (r) => r.client_metadata?.thread_id === threadId,
    );
  }
  close() {
    this.server.closeAllConnections();
    return new Promise<void>((r) => this.server.close(() => r()));
  }
}

function tomlValue(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value))
    return (
      "{ " +
      Object.entries(value)
        .map(([k, v]) => `${JSON.stringify(k)} = ${tomlValue(v)}`)
        .join(", ") +
      " }"
    );
  return JSON.stringify(value);
}

export type ServerRequest = {
  id: string | number;
  method: string;
  params: Json;
};

const running = new Set<CodexHost>();

/**
 * Stops every app-server a spike started. Call from `after()` so a failed
 * assertion mid-test does not leave Codex processes behind.
 */
export async function stopAllHosts() {
  await Promise.all([...running].map((host) => host.stop()));
}

/** One app-server process with the same base config Engine.start() uses. */
export class CodexHost {
  rpc = new CodexRPC();
  /** Exit alone does not drain inherited pipes or final notifications. */
  processClosed: Promise<void> = Promise.resolve();
  notifications: Json[] = [];
  serverRequests: ServerRequest[] = [];
  /** Answers app-server → client requests; default declines. */
  onRequest: (req: ServerRequest) => unknown = () => undefined;
  constructor(
    readonly home: string,
    readonly mock: MockResponses,
    readonly extraConfig: Record<string, unknown> = {},
    readonly extraEnv: Record<string, string> = {},
  ) {}
  async start() {
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const config: Record<string, unknown> = {
      model_provider: "spike",
      "model_providers.spike": {
        name: "Spike fixture",
        base_url: this.mock.url,
        env_key: "SPIKE_GATEWAY_TOKEN",
        wire_api: "responses",
        requires_openai_auth: false,
        request_max_retries: 0,
        stream_max_retries: 0,
        supports_websockets: false,
      },
      web_search: "disabled",
      "features.enable_request_compression": false,
      "features.responses_websockets_v2": false,
      "analytics.enabled": false,
      check_for_update_on_startup: false,
      ...this.extraConfig,
    };
    const args = ["app-server", "--listen", "stdio://"];
    for (const [key, value] of Object.entries(config))
      args.push("-c", `${key}=${tomlValue(value)}`);
    this.rpc.on("notification", (msg) => this.notifications.push(msg));
    this.rpc.on("request", async (msg) => {
      const req = { id: msg.id, method: msg.method, params: msg.params };
      this.serverRequests.push(req);
      try {
        const answer = await this.onRequest(req);
        if (answer === undefined) this.rpc.reject(msg.id, "declined by spike");
        else this.rpc.respond(msg.id, answer);
      } catch (error) {
        this.rpc.reject(msg.id, String(error));
      }
    });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: this.home,
      SPIKE_GATEWAY_TOKEN: FAKE_KEY,
      ...this.extraEnv,
    };
    delete env.OPENAI_API_KEY;
    running.add(this);
    await this.rpc.startWith(() => {
      const child = spawn(resolveRuntime(), args, {
        env,
        stdio: "pipe",
        windowsHide: true,
      });
      this.processClosed = new Promise<void>((resolve) =>
        child.once("close", () => resolve()),
      );
      return child;
    });
    return this;
  }
  /** Runs one turn to completion and returns the turn/completed params. */
  async turn(threadId: string, text: string, extra: Json = {}) {
    const before = this.notifications.length;
    const result = await this.rpc.call("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      ...extra,
    });
    const turnId = result.turn?.id;
    if (typeof turnId !== "string" || !turnId)
      throw new Error("turn/start returned no turn ID.");
    await until(
      () =>
        this.notifications
          .slice(before)
          .some(
            (n) =>
              n.method === "turn/completed" &&
              n.params?.threadId === threadId &&
              n.params?.turn?.id === turnId,
          ),
      `turn/completed for ${text}`,
      60_000,
    );
    const done = this.notifications
      .slice(before)
      .find(
        (n) =>
          n.method === "turn/completed" &&
          n.params?.threadId === threadId &&
          n.params?.turn?.id === turnId,
      )!;
    const items = this.notifications
      .slice(before)
      .filter(
        (n) =>
          n.method === "item/completed" &&
          n.params?.threadId === threadId &&
          n.params?.turnId === turnId,
      )
      .map((n) => n.params.item);
    return { start: result, completed: done.params, items };
  }
  /** thread/start with the options Engine.threadOptions() sends. */
  async thread(model: string, cwd: string, extra: Json = {}) {
    fs.mkdirSync(cwd, { recursive: true });
    const result = await this.rpc.call("thread/start", {
      model,
      modelProvider: "spike",
      cwd,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      ...extra,
    });
    return result.thread.id as string;
  }
  async stop() {
    running.delete(this);
    try {
      await this.rpc.stop();
    } finally {
      await this.processClosed;
    }
  }
}

export function tempRoot(label: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `claudex-spike-${label}-`));
}

/** Findings are written next to the spikes so later packages can read them. */
export function writeFinding(name: string, data: unknown) {
  const dir = path.join(import.meta.dirname, "results");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.json`),
    JSON.stringify(data, null, 2) + "\n",
  );
}

export function toolSearchCall(query: string, id: string): Json {
  return {
    id,
    type: "tool_search_call",
    call_id: id,
    execution: "client",
    arguments: { query, limit: 8 },
    status: "completed",
  };
}

/** Items after the turn's user prompt (the last user message). */
export function turnItems(body: Json): Json[] {
  const input: Json[] = body.input ?? [];
  let last = -1;
  input.forEach((x, i) => {
    if (x.type === "message" && x.role === "user") last = i;
  });
  return input.slice(last + 1);
}

/**
 * A fixture model that calls tools in order (matched by name suffix), using
 * tool_search first when Codex defers the tool, then answers PLAN_DONE.
 */
export function toolPlan(
  steps: Array<{ suffix: string; args?: Json }>,
): Script {
  let calls = 0;
  return (body) => {
    const items = turnItems(body);
    const done = items.filter((x) => x.type === "function_call_output").length;
    const step = steps[done];
    if (!step) return [message("PLAN_DONE")];
    const visible = [
      ...flattenTools(body.tools),
      ...flattenTools(
        items.flatMap((x) => (x.type === "tool_search_output" ? x.tools : [])),
      ),
    ];
    const tool = visible.find((t) => t.name?.endsWith(step.suffix));
    calls++;
    if (tool) return [functionCall(tool, `call_${calls}`, step.args ?? {})];
    const searched = items.some(
      (x) =>
        x.type === "tool_search_call" && x.arguments?.query === step.suffix,
    );
    const canSearch = flattenTools(body.tools).some(
      (t) => t.type === "tool_search",
    );
    if (!searched && canSearch)
      return [toolSearchCall(step.suffix, `ts_${calls}`)];
    return [message(`NO_TOOL:${step.suffix}`)];
  };
}

/** Function call outputs in a request. */
export function outputs(body: Json): Json[] {
  return (body.input ?? []).filter(
    (x: Json) => x.type === "function_call_output",
  );
}

/** Tools the request advertises plus any a tool_search in this turn returned. */
export function reachableTools(body: Json): string[] {
  const searched = turnItems(body).flatMap((x) =>
    x.type === "tool_search_output" ? x.tools : [],
  );
  return [...toolNames(body), ...toolNames({ tools: searched })];
}
