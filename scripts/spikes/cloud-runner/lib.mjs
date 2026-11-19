// Building blocks for the cloud runner spike (W-SPIKE / RUN-0). Runs inside
// the spike container (see run.sh): a Responses mock, an allowlisting egress
// proxy, three launchers (direct, bwrap, runsc) and a small app-server client.
// No credentials: the model is a loopback fixture and the key is fake.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";

export const MODEL = "gpt-5.2-codex";
export const FAKE_KEY = "spike-key-not-a-real-credential";
export const CODEX_DIR = "/opt/codex";
export const SPIKE_DIR = "/opt/spike";
const SANDBOX_UID = 1000;
/** In-sandbox loopback ports the bridge listens on. */
export const MODEL_PORT = 18401;
export const PROXY_PORT = 3128;

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(predicate, label, ms = 60_000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error(`Timed out: ${label}`);
    await delay(25);
  }
}

// ---------------------------------------------------------------- mock model

export function message(text) {
  return {
    id: "msg_" + Date.now() + Math.random().toString(36).slice(2, 6),
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

export function functionCall(name, callId, args) {
  return {
    id: `fc_${callId}`,
    type: "function_call",
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
    status: "completed",
  };
}

function responseEvents(output, responseId) {
  let sequence = 0;
  const events = [];
  const add = (e) => events.push({ ...e, sequence_number: sequence++ });
  const response = {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: MODEL,
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
        ...(item.type === "message" ? { content: [] } : { arguments: "" }),
      },
    });
    if (item.type === "message") {
      const part = item.content[0];
      const base = { output_index: i, item_id: item.id, content_index: 0 };
      add({
        type: "response.content_part.added",
        ...base,
        part: { ...part, text: "" },
      });
      add({ type: "response.output_text.delta", ...base, delta: part.text });
      add({ type: "response.output_text.done", ...base, text: part.text });
      add({ type: "response.content_part.done", ...base, part });
    } else {
      const base = { output_index: i, item_id: item.id };
      add({
        type: "response.function_call_arguments.delta",
        ...base,
        delta: item.arguments,
      });
      add({
        type: "response.function_call_arguments.done",
        ...base,
        arguments: item.arguments,
      });
    }
    add({ type: "response.output_item.done", output_index: i, item });
  });
  add({ type: "response.completed", response });
  return events;
}

/** Items after the turn's user prompt. */
export function turnItems(body) {
  const input = body.input ?? [];
  let last = -1;
  input.forEach((x, i) => {
    if (x.type === "message" && x.role === "user") last = i;
  });
  return input.slice(last + 1);
}

export function outputs(body) {
  return (body?.input ?? []).filter((x) => x.type === "function_call_output");
}

export function outputText(o) {
  if (!o) return "";
  return typeof o.output === "string" ? o.output : JSON.stringify(o.output);
}

export function toolNames(body) {
  const flat = (tools = [], ns) =>
    tools.flatMap((t) =>
      t.type === "namespace"
        ? flat(t.tools, t.name)
        : [ns ? `${ns}/${t.name ?? t.type}` : (t.name ?? t.type)],
    );
  return flat(body.tools);
}

export class MockResponses {
  requests = [];
  script = () => [message("ok")];
  url = "";
  port = 0;
  server = http.createServer((req, res) => this.handle(req, res));
  async start() {
    await new Promise((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = this.server.address().port;
    this.url = `http://127.0.0.1:${this.port}/v1`;
    return this;
  }
  async handle(req, res) {
    try {
      if (req.headers.authorization !== `Bearer ${FAKE_KEY}`) {
        res.writeHead(401).end();
        return;
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      if (req.url !== "/v1/responses") {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const index = this.requests.push(body) - 1;
      const output = await this.script(body, index);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const e of responseEvents(output, `resp_${index}`))
        res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      res.end();
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  }
  forThread(threadId) {
    return this.requests.filter(
      (r) => r.client_metadata?.thread_id === threadId,
    );
  }
  close() {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }
}

/**
 * A fixture model that runs one shell command through Codex's exec tool,
 * polls it with write_stdin until the output carries `EXIT=`, then answers.
 */
export function execPlan(cmd, { yieldMs = 30_000, maxPolls = 12 } = {}) {
  let calls = 0;
  return (body) => {
    const items = turnItems(body);
    const outs = items.filter((x) => x.type === "function_call_output");
    const names = toolNames(body);
    const last = outputText(outs.at(-1));
    if (outs.length === 0) {
      const tool = names.find((n) => n === "exec_command");
      if (!tool) return [message(`NO_EXEC_TOOL:${names.join(",")}`)];
      calls++;
      return [
        functionCall("exec_command", `call_${calls}`, {
          cmd,
          login: false,
          yield_time_ms: yieldMs,
          max_output_tokens: 4000,
        }),
      ];
    }
    const session = /session ID (\d+)/i.exec(last)?.[1];
    if (!/EXIT=\d+/.test(last) && session && outs.length <= maxPolls) {
      calls++;
      return [
        functionCall("write_stdin", `call_${calls}`, {
          session_id: Number(session),
          chars: "",
          yield_time_ms: yieldMs,
          max_output_tokens: 4000,
        }),
      ];
    }
    return [message("EXEC_DONE")];
  };
}

// -------------------------------------------------------------- egress proxy

/**
 * HTTP proxy (CONNECT and absolute-URI requests) that only lets allowlisted
 * hosts through and records every attempt. It listens on a Unix socket that
 * is bound into the sandbox, so the sandbox has no other way out.
 */
export class EgressProxy {
  log = [];
  constructor(allow) {
    this.allow = allow;
  }
  allowed(host) {
    return this.allow.some((a) => host === a || host.endsWith("." + a));
  }
  listen(socketPath) {
    const server = http.createServer((req, res) => {
      let url;
      try {
        url = new URL(req.url);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const ok = url.protocol === "http:" && this.allowed(url.hostname);
      this.log.push({ kind: "http", host: url.hostname, allowed: ok });
      if (!ok) {
        res.writeHead(403).end("blocked by spike egress proxy");
        return;
      }
      const upstream = http.request(
        url,
        { method: req.method, headers: req.headers },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        },
      );
      upstream.on("error", () => res.destroy());
      req.pipe(upstream);
    });
    server.on("connect", (req, client, head) => {
      const [host, port] = String(req.url).split(":");
      const ok = this.allowed(host) && port === "443";
      const entry = { kind: "connect", host, port, allowed: ok, bytes: 0 };
      this.log.push(entry);
      if (!ok) {
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const upstream = net.connect(Number(port), host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("data", (d) => (entry.bytes += d.length));
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      upstream.on("error", (e) => {
        entry.error = e.code ?? String(e);
        close();
      });
      client.on("error", close);
    });
    this.servers = [...(this.servers ?? []), server];
    return listenUnix(server, socketPath);
  }
  close() {
    for (const s of this.servers ?? []) {
      s.closeAllConnections?.();
      s.close();
    }
  }
}

function listenUnix(server, socketPath) {
  fs.rmSync(socketPath, { force: true });
  return new Promise((resolve) =>
    server.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o777);
      resolve(server);
    }),
  );
}

/** Unix socket → TCP forwarder: the runner side of the model gateway. */
export function unixToTcp(socketPath, port) {
  const server = net.createServer((client) => {
    const upstream = net.connect(port, "127.0.0.1");
    client.pipe(upstream).pipe(client);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
  });
  return listenUnix(server, socketPath);
}

// ------------------------------------------------------------------ sandboxes

const ROOTFS = "/var/spike/rootfs";
/**
 * A root filesystem for runsc, like an image's: a copy of the container's
 * userland plus the mount targets. With the container's own "/" as the OCI
 * root, runsc's gofer drops every bind mount (the sandbox sees the empty
 * mount-point directories instead), so a separate root directory is needed.
 */
function runscRootfs() {
  if (fs.existsSync(path.join(ROOTFS, ".ready"))) return ROOTFS;
  fs.mkdirSync(ROOTFS, { recursive: true });
  const r = spawnSync("cp", [
    "-a",
    "/bin",
    "/sbin",
    "/lib",
    "/usr",
    "/etc",
    ROOTFS,
  ]);
  if (r.status !== 0) throw new Error(`rootfs copy failed: ${r.stderr}`);
  for (const d of [
    "proc",
    "dev",
    "sys",
    "tmp",
    "run/claudex",
    "codex-home",
    "workspace",
    "scratch",
    "opt/codex",
    "opt/spike",
  ])
    fs.mkdirSync(path.join(ROOTFS, d), { recursive: true });
  fs.writeFileSync(path.join(ROOTFS, ".ready"), "");
  return ROOTFS;
}

function chownTree(dir) {
  spawnSync("chown", ["-R", `${SANDBOX_UID}:${SANDBOX_UID}`, dir]);
}

/**
 * One sandbox's host directories and how to run a command in it.
 * kind: "direct" (no isolation, baseline), "bwrap" (bubblewrap as an
 * unprivileged user: new user/pid/net/ipc/uts/cgroup namespaces) or "runsc"
 * (gVisor, OCI bundle run with --network=none and host UDS connect only).
 * Inside bwrap/runsc the paths are fixed (/codex-home, /workspace, ...), so a
 * snapshot can be restored under a different host path.
 */
export class Sandbox {
  constructor(kind, root, label) {
    this.kind = kind;
    this.label = label;
    this.root = path.join(root, label);
    this.host = {
      home: path.join(this.root, "codex-home"),
      ws: path.join(this.root, "workspace"),
      scratch: path.join(this.root, "scratch"),
      sock: path.join(this.root, "sock"),
    };
    for (const d of Object.values(this.host))
      fs.mkdirSync(d, { recursive: true, mode: 0o755 });
    chownTree(this.root);
    // Prepared up front so the copy is not counted as start-up time.
    if (kind === "runsc") runscRootfs();
  }
  /** runsc's own view of the sandbox's memory (runsc events --stats). */
  runscStats() {
    if (this.kind !== "runsc" || !this.containerId) return undefined;
    const r = spawnSync(
      "runsc",
      ["--root=/run/runsc", "events", "--stats", this.containerId],
      { encoding: "utf8" },
    );
    try {
      const mem = JSON.parse(r.stdout).data?.memory ?? {};
      const mib = (v) =>
        typeof v === "number" ? Math.round((v / 1048576) * 10) / 10 : v;
      return Object.fromEntries(
        Object.entries(mem).map(([k, v]) => [
          k,
          typeof v === "object" && v ? mib(v.usage ?? v.value ?? 0) : mib(v),
        ]),
      );
    } catch {
      return { error: (r.stderr || r.stdout || "").slice(0, 300) };
    }
  }
  get inner() {
    if (this.kind === "direct") return this.host;
    return {
      home: "/codex-home",
      ws: "/workspace",
      scratch: "/scratch",
      sock: "/run/claudex",
    };
  }
  /** Environment for commands in the sandbox (proxy only when sandboxed). */
  env(extra = {}) {
    const base = {
      PATH: `${CODEX_DIR}/codex-path:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: path.join(this.inner.home, "home"),
      CODEX_HOME: this.inner.home,
      LANG: "C.UTF-8",
      SPIKE_GATEWAY_TOKEN: FAKE_KEY,
    };
    if (this.kind !== "direct") {
      const proxy = `http://127.0.0.1:${PROXY_PORT}`;
      Object.assign(base, {
        HTTPS_PROXY: proxy,
        HTTP_PROXY: proxy,
        https_proxy: proxy,
        http_proxy: proxy,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        // pip and git use the system CA bundle; npm its own.
      });
    }
    return { ...base, ...extra };
  }
  /** Starts the runner side of the bridges (model gateway and egress proxy). */
  async listen(mock, proxy) {
    if (this.kind === "direct") return;
    this.servers = [
      await unixToTcp(path.join(this.host.sock, "model.sock"), mock.port),
    ];
    await proxy.listen(path.join(this.host.sock, "proxy.sock"));
  }
  close() {
    for (const s of this.servers ?? []) {
      s.closeAllConnections?.();
      s.close();
    }
  }
  modelUrl(mock) {
    return this.kind === "direct"
      ? mock.url
      : `http://127.0.0.1:${MODEL_PORT}/v1`;
  }
  /** argv run inside the sandbox after the bridges are up. */
  wrap(argv) {
    if (this.kind === "direct") return argv;
    const ready = "/tmp/.bridge-ready";
    const script =
      `node ${SPIKE_DIR}/bridge.mjs ${MODEL_PORT}=/run/claudex/model.sock ` +
      `${PROXY_PORT}=/run/claudex/proxy.sock --ready ${ready} & ` +
      `i=0; while [ ! -e ${ready} ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done; ` +
      `exec "$@"`;
    return ["/bin/sh", "-c", script, "sh", ...argv];
  }
  /** Spawns argv in the sandbox; returns the child process. */
  spawn(argv, env) {
    const inner = this.wrap(argv);
    if (this.kind === "direct") {
      return spawn(inner[0], inner.slice(1), {
        env,
        cwd: this.host.ws,
        stdio: "pipe",
        uid: SANDBOX_UID,
        gid: SANDBOX_UID,
      });
    }
    if (this.kind === "bwrap") {
      const args = [
        "--die-with-parent",
        "--unshare-all",
        "--unshare-user",
        "--uid",
        String(SANDBOX_UID),
        "--gid",
        String(SANDBOX_UID),
        "--hostname",
        "sandbox",
        ...["/usr", "/lib", "/bin", "/sbin", "/etc"].flatMap((p) => [
          "--ro-bind",
          p,
          p,
        ]),
        ...["--ro-bind", CODEX_DIR, CODEX_DIR],
        ...["--ro-bind", SPIKE_DIR, SPIKE_DIR],
        ...["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"],
        ...["--bind", this.host.home, "/codex-home"],
        ...["--bind", this.host.ws, "/workspace"],
        ...["--bind", this.host.scratch, "/scratch"],
        ...["--bind", this.host.sock, "/run/claudex"],
        ...["--chdir", "/workspace", "--clearenv"],
        ...Object.entries(env).flatMap(([k, v]) => ["--setenv", k, v]),
        "--",
        ...inner,
      ];
      // Unprivileged, like the production runner user.
      return spawn(
        "su-exec",
        [`${SANDBOX_UID}:${SANDBOX_UID}`, "bwrap", ...args],
        {
          stdio: "pipe",
          env: { PATH: process.env.PATH },
        },
      );
    }
    if (this.kind === "runsc") {
      const bundle = path.join(this.root, `bundle-${Date.now()}`);
      fs.mkdirSync(bundle, { recursive: true });
      const bind = (source, destination, ro = false) => ({
        destination,
        type: "bind",
        source,
        options: ["rbind", ro ? "ro" : "rw"],
      });
      const config = {
        ociVersion: "1.0.2",
        process: {
          terminal: false,
          user: { uid: SANDBOX_UID, gid: SANDBOX_UID },
          args: inner,
          env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
          cwd: "/workspace",
          noNewPrivileges: true,
          capabilities: {
            bounding: [],
            effective: [],
            inheritable: [],
            permitted: [],
          },
        },
        root: { path: runscRootfs(), readonly: true },
        hostname: "sandbox",
        mounts: [
          { destination: "/proc", type: "proc", source: "proc" },
          { destination: "/dev", type: "tmpfs", source: "tmpfs" },
          {
            destination: "/sys",
            type: "sysfs",
            source: "sysfs",
            options: ["ro"],
          },
          { destination: "/tmp", type: "tmpfs", source: "tmpfs" },
          bind(CODEX_DIR, CODEX_DIR, true),
          bind(SPIKE_DIR, SPIKE_DIR, true),
          bind(this.host.home, "/codex-home"),
          bind(this.host.ws, "/workspace"),
          bind(this.host.scratch, "/scratch"),
          bind(this.host.sock, "/run/claudex"),
        ],
        linux: {
          namespaces: ["pid", "ipc", "uts", "mount", "network"].map((type) => ({
            type,
          })),
        },
      };
      fs.writeFileSync(
        path.join(bundle, "config.json"),
        JSON.stringify(config),
      );
      const id = `spike-${this.label}-${Date.now()}`.replace(/[^\w-]/g, "-");
      this.containerId = id;
      fs.mkdirSync("/run/runsc", { recursive: true });
      fs.mkdirSync(path.join(this.root, "runsc-logs"), { recursive: true });
      const runsc = [
        "runsc",
        "--root=/run/runsc",
        `--platform=${process.env.RUNSC_PLATFORM ?? "systrap"}`,
        "--network=none",
        "--host-uds=open",
        "--ignore-cgroups",
        `--debug-log=${path.join(this.root, "runsc-logs")}/`,
        ...(process.env.RUNSC_FLAGS ?? "").split(" ").filter(Boolean),
        "run",
        "--bundle",
        bundle,
        id,
      ];
      // Node's stdio pipes (Unix socketpairs) work as the sandbox's stdio.
      const child = spawn(runsc[0], runsc.slice(1), {
        stdio: "pipe",
        env: { PATH: process.env.PATH },
      });
      child.once("exit", () => {
        spawnSync("runsc", ["--root=/run/runsc", "delete", "--force", id]);
      });
      return child;
    }
    throw new Error(`unknown sandbox ${this.kind}`);
  }
  /** Runs a shell command in the sandbox and collects its output. */
  exec(cmd, { timeoutMs = 180_000 } = {}) {
    const started = Date.now();
    const child = this.spawn(["/bin/sh", "-c", cmd], this.env());
    child.stdin.end();
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    return new Promise((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ code: -1, ms: 0, output: String(error) });
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({
          code,
          signal,
          ms: Date.now() - started,
          output: out.slice(-3000),
        });
      });
    });
  }
}

// ----------------------------------------------------------- process memory

function children() {
  const map = new Map();
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
      if (!map.has(ppid)) map.set(ppid, []);
      map.get(ppid).push({ pid: Number(entry), comm });
    } catch {}
  }
  return map;
}

function rollup(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    const kb = (k) =>
      Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0);
    return {
      rss: kb("Rss"),
      pss: kb("Pss"),
      anon: kb("Pss_Anon"),
      file: kb("Pss_File"),
      shmem: kb("Pss_Shmem"),
    };
  } catch {
    return { rss: 0, pss: 0, anon: 0, file: 0, shmem: 0 };
  }
}

/** RSS and PSS (MiB) of a process tree, with per-command totals. */
export function treeMemory(rootPid) {
  const map = children();
  const stack = [{ pid: rootPid, comm: "root" }];
  let rss = 0;
  let pss = 0;
  const kinds = { anon: 0, file: 0, shmem: 0 };
  const byComm = {};
  while (stack.length) {
    const p = stack.pop();
    const m = rollup(p.pid);
    rss += m.rss;
    pss += m.pss;
    for (const k of Object.keys(kinds)) kinds[k] += m[k];
    let comm = p.comm;
    try {
      comm = fs.readFileSync(`/proc/${p.pid}/comm`, "utf8").trim();
    } catch {}
    byComm[comm] = (byComm[comm] ?? 0) + m.pss;
    stack.push(...(map.get(p.pid) ?? []));
  }
  const mib = (kb) => Math.round((kb / 1024) * 10) / 10;
  return {
    rssMiB: mib(rss),
    pssMiB: mib(pss),
    // Under gVisor the sandbox's memory (including its own page cache for
    // files read through the gofer) is the sentry's memfd, i.e. Shmem.
    pssAnonMiB: mib(kinds.anon),
    pssFileMiB: mib(kinds.file),
    pssShmemMiB: mib(kinds.shmem),
    pssByCommandMiB: Object.fromEntries(
      Object.entries(byComm)
        .filter(([, v]) => v > 1024)
        .map(([k, v]) => [k, mib(v)]),
    ),
  };
}

/** Samples a tree until stop() and reports the peak. */
export function sampler(pid, everyMs = 200) {
  let peak = { rssMiB: 0, pssMiB: 0 };
  let samples = 0;
  const timer = setInterval(() => {
    const m = treeMemory(pid);
    samples++;
    if (m.pssMiB > peak.pssMiB) peak = m;
  }, everyMs);
  return {
    stop() {
      clearInterval(timer);
      return { ...peak, samples };
    },
  };
}

export function cgroupMemoryMiB() {
  try {
    return (
      Math.round(
        (Number(fs.readFileSync("/sys/fs/cgroup/memory.current", "utf8")) /
          1048576) *
          10,
      ) / 10
    );
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ app-server

function tomlValue(value) {
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

/** One `codex app-server` in a sandbox, spoken to over stdio JSON-RPC. */
export class CodexHost {
  notifications = [];
  serverRequests = [];
  pending = new Map();
  next = 1;
  stderr = "";
  constructor(sandbox, mock) {
    this.sandbox = sandbox;
    this.mock = mock;
  }
  async start() {
    const config = {
      model_provider: "spike",
      "model_providers.spike": {
        name: "Spike fixture",
        base_url: this.sandbox.modelUrl(this.mock),
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
    };
    const argv = [
      `${CODEX_DIR}/bin/codex`,
      "app-server",
      "--listen",
      "stdio://",
    ];
    for (const [k, v] of Object.entries(config))
      argv.push("-c", `${k}=${tomlValue(v)}`);
    fs.mkdirSync(path.join(this.sandbox.host.home, "home"), {
      recursive: true,
    });
    chownTree(this.sandbox.host.home);
    const started = Date.now();
    const child = (this.child = this.sandbox.spawn(argv, this.sandbox.env()));
    this.exited = new Promise((resolve) => {
      const done = (exit) => {
        if (this.exit) return;
        this.exit = exit;
        for (const p of this.pending.values())
          p.reject(new Error(`codex exited (${JSON.stringify(exit)})`));
        this.pending.clear();
        resolve();
      };
      child.on("error", (error) => done({ error: String(error) }));
      child.on("exit", (code, signal) => done({ code, signal }));
    });
    child.stderr.on("data", (d) => {
      this.stderr = (this.stderr + d).slice(-20_000);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.method && msg.id !== undefined) {
        this.serverRequests.push(msg);
        // Decline everything (approvals are not part of this spike).
        this.write({
          id: msg.id,
          error: { code: -32601, message: "declined" },
        });
      } else if (msg.method) this.notifications.push(msg);
      else {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    });
    this.initialize = await this.call(
      "initialize",
      {
        clientInfo: {
          name: "claudex_runner_spike",
          title: "Claudex",
          version: "0.0.0",
        },
        capabilities: { experimentalApi: true },
      },
      120_000,
    );
    this.write({ method: "initialized", params: {} });
    this.startupMs = Date.now() - started;
    return this;
  }
  write(v) {
    this.child?.stdin.writable &&
      this.child.stdin.write(JSON.stringify(v) + "\n");
  }
  call(method, params = {}, timeout = 60_000) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeout);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.write({ id, method, params });
    });
  }
  async thread(extra = {}) {
    const result = await this.call("thread/start", {
      model: MODEL,
      modelProvider: "spike",
      cwd: this.sandbox.inner.ws,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      ...extra,
    });
    return result.thread.id;
  }
  resume(threadId, extra = {}) {
    return this.call("thread/resume", {
      threadId,
      model: MODEL,
      modelProvider: "spike",
      cwd: this.sandbox.inner.ws,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      ...extra,
    });
  }
  async turn(threadId, text, extra = {}, ms = 240_000) {
    const before = this.notifications.length;
    const seen = this.mock.forThread(threadId).length;
    await this.call("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      ...extra,
    });
    const done = () =>
      this.notifications
        .slice(before)
        .find(
          (n) =>
            n.method === "turn/completed" && n.params?.threadId === threadId,
        );
    await until(() => !!done() || !!this.exit, `turn/completed: ${text}`, ms);
    if (!done())
      throw new Error(
        `codex exited during the turn: ${JSON.stringify(this.exit)}`,
      );
    const requests = this.mock.forThread(threadId).slice(seen);
    const items = this.notifications
      .slice(before)
      .filter(
        (n) => n.method === "item/completed" && n.params?.threadId === threadId,
      )
      .map((n) => n.params.item);
    return { completed: done().params, requests, items };
  }
  async stop() {
    const child = this.child;
    if (!child || this.exit) return;
    child.stdin.end();
    const t1 = setTimeout(() => child.kill("SIGTERM"), 3000);
    const t2 = setTimeout(() => child.kill("SIGKILL"), 8000);
    await this.exited;
    clearTimeout(t1);
    clearTimeout(t2);
  }
}

/** Last lines of a log with anything that looks like a secret removed. */
export function tail(text, n = 15) {
  return text
    .split("\n")
    .filter(Boolean)
    .slice(-n)
    .map((l) => l.replace(/Bearer\s+\S+/g, "Bearer <redacted>").slice(0, 400));
}
