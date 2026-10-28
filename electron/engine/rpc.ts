import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
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

export class CodexRPC extends EventEmitter {
  private process?: ChildProcessWithoutNullStreams;
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
    const child = (this.process = spawnFn());
    let failed: Error | undefined;
    let storageFull = false;
    let stderrTail = "";
    const fail = (error: Error) => {
      failed ??= error;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      this.pending.clear();
      this.emit("failure", error);
    };
    child.on("error", fail);
    child.on("exit", (code, signal) => {
      if (this.process === child) this.process = undefined;
      fail(
        new Error(
          storageFull
            ? storageFullMessage
            : `The Codex process exited (${code ?? signal})`,
        ),
      );
    });
    // A closed pipe is reported through "exit"; a write never throws.
    child.stdin.on("error", (error) => {
      if (isStorageFullError(error)) fail(new Error(storageFullMessage));
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
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
    });
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
    this.notify("initialized", {});
    return result;
  }
  /** The process runs and takes requests. */
  get connected() {
    return !!this.process?.stdin.writable;
  }
  call(method: string, params: any = {}, timeout = 60_000): Promise<any> {
    if (!this.process?.stdin.writable)
      return Promise.reject(new Error("The Codex engine is not connected."));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  private write(value: any) {
    this.process?.stdin.write(JSON.stringify(value) + "\n");
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
