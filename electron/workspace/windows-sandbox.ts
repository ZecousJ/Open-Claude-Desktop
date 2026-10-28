import fs from "node:fs";
import path from "node:path";
interface SandboxRPC {
  call(method: string, params?: any): Promise<any>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}
const MODE = "unelevated";
const RECEIPT_VERSION = 1;
const RUNTIME_VERSION = "0.144.1";
const SETUP_GUIDANCE =
  "The Windows sandbox couldn't be set up. Try again, or run Set up under Windows sandbox in Settings → Claudex Code.";

/** Wait for the asynchronous completion event, including when it precedes the RPC reply. */
export function runWindowsSandboxSetup(
  rpc: SandboxRPC,
  cwd: string,
  timeoutMs = 120_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let accepted = false;
    let completed: { success: boolean; error?: string | null } | undefined;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      rpc.off("notification", onNotification);
      rpc.off("failure", onFailure);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const finishIfComplete = () => {
      if (!accepted || !completed) return;
      finish(
        completed.success
          ? undefined
          : new Error(
              `Windows sandbox setup failed: ${completed.error || "the engine gave no reason"}`,
            ),
      );
    };
    const onNotification = (message: any) => {
      if (
        message.method !== "windowsSandbox/setupCompleted" ||
        message.params?.mode !== MODE
      )
        return;
      completed = message.params;
      finishIfComplete();
    };
    const onFailure = (error: Error) =>
      finish(
        new Error(`Windows sandbox setup was interrupted: ${error.message}`),
      );
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "Windows sandbox setup timed out. Try again in Settings → Claudex Code.",
          ),
        ),
      timeoutMs,
    );
    rpc.on("notification", onNotification);
    rpc.on("failure", onFailure);
    void rpc.call("windowsSandbox/setupStart", { mode: MODE, cwd }).then(
      (result) => {
        if (!result?.started) {
          finish(new Error("Codex did not start the Windows sandbox setup."));
          return;
        }
        accepted = true;
        finishIfComplete();
      },
      (error) =>
        finish(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

/** Codex 0.144.1 reports unelevated readiness from config alone; keep a completed-setup receipt too. */
export class WindowsSandbox {
  private ready = false;
  private generation = 0;
  private pending?: Promise<{ ready: boolean; message: string }>;
  private readonly receiptPath: string;
  constructor(
    root: string,
    private platform: NodeJS.Platform = process.platform,
  ) {
    this.receiptPath = path.join(root, "windows-sandbox.json");
    this.ready = platform !== "win32";
  }
  reset() {
    this.ready = this.platform !== "win32";
    this.generation++;
  }
  assertReady() {
    if (!this.ready) throw new Error(SETUP_GUIDANCE);
  }
  get isReady() {
    return this.ready;
  }
  /**
   * Ready before a turn: waits for a setup already under way, or runs one
   * now (Claudex sets the sandbox up by itself; the Settings button only
   * retries). A failed setup says so in the turn's error.
   */
  async ensureReady(rpc: SandboxRPC, cwd: string) {
    if (this.ready) return;
    try {
      await this.setup(rpc, cwd);
    } catch (error) {
      throw new Error(
        `${SETUP_GUIDANCE} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    this.assertReady();
  }
  async check(rpc: SandboxRPC): Promise<boolean> {
    if (this.platform !== "win32") return true;
    const generation = this.generation;
    this.ready = false;
    try {
      const receipt = JSON.parse(fs.readFileSync(this.receiptPath, "utf8"));
      if (
        receipt.version !== RECEIPT_VERSION ||
        receipt.runtimeVersion !== RUNTIME_VERSION ||
        receipt.mode !== MODE
      )
        return false;
      const result = await rpc.call("windowsSandbox/readiness", {});
      if (generation !== this.generation) return false;
      this.ready = result?.status === "ready";
    } catch {
      this.ready = false;
    }
    return this.ready;
  }
  setup(
    rpc: SandboxRPC,
    cwd: string,
  ): Promise<{ ready: boolean; message: string }> {
    if (this.platform !== "win32")
      return Promise.resolve({
        ready: true,
        message: "This platform doesn't need the Windows sandbox.",
      });
    if (this.pending) return this.pending;
    const generation = this.generation;
    this.ready = false;
    const work = async () => {
      await runWindowsSandboxSetup(rpc, cwd);
      const result = await rpc.call("windowsSandbox/readiness", {});
      if (generation !== this.generation)
        throw new Error(
          "The engine reconnected. Set up the Windows sandbox again.",
        );
      if (result?.status !== "ready")
        throw new Error(
          "The Windows sandbox still isn't ready. Try again in Settings → Claudex Code.",
        );
      fs.mkdirSync(path.dirname(this.receiptPath), {
        recursive: true,
        mode: 0o700,
      });
      const temporary = this.receiptPath + ".tmp";
      fs.writeFileSync(
        temporary,
        JSON.stringify({
          version: RECEIPT_VERSION,
          runtimeVersion: RUNTIME_VERSION,
          mode: MODE,
          completedAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
      fs.renameSync(temporary, this.receiptPath);
      this.ready = true;
      return {
        ready: true,
        message:
          "The Windows restricted-token sandbox is set up. You can start conversations and run local tasks.",
      };
    };
    const pending = work().finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }
}
