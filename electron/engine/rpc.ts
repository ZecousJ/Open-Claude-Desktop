import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { version as appVersion } from "../../package.json";
import { withUtf8Locale } from "./locale-env";
import {
  isStorageFullError,
  storageFullMessage,
} from "../../shared/turn-errors";

/**
 * Text written to the Codex process's stdin before JSON-RPC starts (R9): an
 * SSH engine's wrapper reads its forwarded port and gateway token this way,
 * so neither is ever on a command line. A function is called once the
 * process runs (the port of a remote forward may only be known then).
 */
export type RpcPreamble =
  | string
  | ((child: ChildProcessWithoutNullStreams) => Promise<string> | string);

export class CodexRequestTimeout extends Error {
  constructor(method: string) {
    super(`${method} timed out`);
  }
}

export class CodexRPC extends EventEmitter {
  private process?: ChildProcessWithoutNullStreams;
  private failure?: Error;
  private next = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  /** Starts the local Codex app-server. */
  async start(binary: string, args: string[], env: NodeJS.ProcessEnv) {
    return this.startWith(() =>
      spawn(binary, args, {
        env: withUtf8Locale(env),
        stdio: "pipe",
        windowsHide: true,
      }),
    );
  }
  /**
   * Starts Codex through another program (an SSH engine's ssh process):
   * `spawnFn` starts it, `preamble` (optional) is written to its stdin
   * first, then JSON-RPC begins as with `start`. stderr is never forwarded
   * anywhere; a caller that needs it (the port of a remote forward) reads
   * it itself.
   */
  async startWith(
    spawnFn: () => ChildProcessWithoutNullStreams,
    preamble?: RpcPreamble,
  ) {
    if (this.process) await this.stop();
    this.failure = undefined;
    const child = (this.process = spawnFn());
    let failed: Error | undefined;
    let storageFull = false;
    let stderrTail = "";
    const fail = (error: Error) => {
      // A closing/replaced child cannot reject the new process's calls.
      if (this.process !== child || failed) return;
      failed ??= error;
      this.failure = error;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      this.pending.clear();
      this.emit("failure", error);
    };
    child.on("error", fail);
    child.on("exit", (code, signal) => {
      fail(
        new Error(
          storageFull
            ? storageFullMessage
            : `The Codex process exited (${code ?? signal})`,
        ),
      );
      if (this.process === child) this.process = undefined;
    });
    // Pipes can close while the process is still alive (including SSH
    // wrappers). Fail immediately instead of timing out every later call.
    const connectionClosed = () =>
      new Error(
        storageFull
          ? storageFullMessage
          : "The agent connection closed. Send again to reconnect.",
      );
    child.stdin.on("error", (error) => {
      fail(
        isStorageFullError(error)
          ? new Error(storageFullMessage)
          : connectionClosed(),
      );
    });
    child.stdout.on("error", () => fail(connectionClosed()));
    const receive = (line: string) => {
      if (this.process !== child || failed) return;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.method) {
        this.emit(msg.id !== undefined ? "request" : "notification", msg);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    };
    // JSONL uses LF between records. U+2028 and U+2029 are valid text inside a JSON string.
    const fragments: string[] = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      let start = 0;
      for (let end = chunk.indexOf("\n"); end >= 0; end = chunk.indexOf("\n", start)) {
        const part = chunk.slice(start, end);
        if (fragments.length) {
          fragments.push(part);
          receive(fragments.join(""));
          fragments.length = 0;
        } else receive(part);
        start = end + 1;
      }
      if (start < chunk.length) fragments.push(chunk.slice(start));
    });
    child.stdout.once("end", () => {
      if (fragments.length) receive(fragments.join(""));
      fail(connectionClosed());
    });
    child.stdout.once("close", () => fail(connectionClosed()));

    // Never forward process logs or provider credentials to the renderer.
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4096);
      storageFull ||= isStorageFullError(stderrTail);
    });
    if (preamble !== undefined) {
      const text =
        typeof preamble === "string" ? preamble : await preamble(child);
      if (failed) throw failed;
      if (this.process !== child || !child.stdin.writable)
        throw new Error("The Codex engine is not connected.");
      child.stdin.write(text);
    }
    const result = await this.call("initialize", {
      clientInfo: {
        name: "claudex_desktop",
        title: "Claudex",
        version: appVersion,
      },
      capabilities: { experimentalApi: true },
    });
    if (failed) throw failed;
    this.notify("initialized", {});
    return result;
  }
  /** The process runs and takes requests. */
  get connected() {
    return !this.failure && !!this.process?.stdin.writable;
  }
  get processId() {
    return this.process?.pid;
  }
  call(method: string, params: any = {}, timeout = 60_000): Promise<any> {
    if (!this.connected)
      return Promise.reject(
        this.failure ?? new Error("The Codex engine is not connected."),
      );
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRequestTimeout(method));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  private write(value: any) {
    if (this.connected) this.process?.stdin.write(JSON.stringify(value) + "\n");
  }
  notify(method: string, params: any) {
    this.write({ method, params });
  }
  respond(id: string | number, result: any) {
    this.write({ id, result });
  }
  reject(id: string | number, message: string) {
    this.write({ id, error: { code: -32601, message } });
  }
  async stop() {
    const child = this.process;
    this.process = undefined;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(
        new Error("The agent connection closed. Send again to reconnect."),
      );
    }
    this.pending.clear();
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(graceTimer);
        clearTimeout(forceTimer);
        resolve();
      };
      const graceTimer = setTimeout(() => child.kill(), 2000);
      const forceTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish();
      }, 5000);
      child.once("exit", finish);
      child.once("error", finish);
      child.stdin.end();
    });
  }
}
