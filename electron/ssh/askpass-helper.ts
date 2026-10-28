/**
 * The program ssh runs as SSH_ASKPASS for a password, passphrase or host-key
 * question (R9). Built on its own by scripts/build.mjs into
 * `dist-server/ssh-askpass.cjs` and started through a small wrapper
 * (askpass.ts) with ELECTRON_RUN_AS_NODE, it asks the app over a local
 * socket (a named pipe on Windows) and prints the answer for ssh.
 *
 * Protocol, one JSON line each way:
 *   helper → app  {"nonce": "<CLAUDEX_ASKPASS_NONCE>", "prompt": "<ssh's text>", "mode": "<SSH_ASKPASS_PROMPT>"}
 *   app → helper  {"answer": "<text>"} or {"cancel": true}
 * A cancel, a closed socket, a missing variable or two minutes without an
 * answer exit non-zero, which ssh treats as "no answer". The answer is only
 * written to stdout (ssh reads it from there) and never kept.
 *
 * It imports nothing from the app so the bundle stays small.
 */
import net from "node:net";

/** Longest line either side sends. */
export const ASKPASS_MAX_LINE = 16 * 1024;
/** The helper gives up a little after the app's own two-minute limit. */
export const ASKPASS_HELPER_TIMEOUT_MS = 130_000;

export interface AskpassRun {
  /** ssh's question (argv[1] of the askpass program). */
  prompt: string;
  env: NodeJS.ProcessEnv;
  write: (text: string) => void;
  connect?: (socketPath: string) => net.Socket;
  timeoutMs?: number;
}

/** Asks the app; resolves to the exit code for ssh (0 answered, 1 not). */
export function runAskpass(run: AskpassRun): Promise<number> {
  const socketPath = run.env.CLAUDEX_ASKPASS_SOCKET;
  const nonce = run.env.CLAUDEX_ASKPASS_NONCE;
  if (!socketPath || !nonce) return Promise.resolve(1);
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    const socket = (run.connect ?? ((p) => net.createConnection(p)))(
      socketPath,
    );
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(code);
    };
    const timer = setTimeout(
      () => finish(1),
      run.timeoutMs ?? ASKPASS_HELPER_TIMEOUT_MS,
    );
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          nonce,
          prompt: run.prompt.slice(0, 4000),
          mode: run.env.SSH_ASKPASS_PROMPT ?? "",
        })}\n`,
      );
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > ASKPASS_MAX_LINE) return finish(1);
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      let reply: { answer?: unknown; cancel?: unknown } | undefined;
      try {
        reply = JSON.parse(buffer.slice(0, end));
      } catch {
        return finish(1);
      }
      buffer = "";
      if (typeof reply?.answer === "string" && !/[\r\n]/.test(reply.answer)) {
        run.write(`${reply.answer}\n`);
        return finish(0);
      }
      finish(1);
    });
    socket.on("error", () => finish(1));
    socket.on("close", () => finish(1));
  });
}

// Run directly (the bundled dist-server/ssh-askpass.cjs), not when a test
// imports the function above.
if (
  typeof require !== "undefined" &&
  typeof module !== "undefined" &&
  require.main === module
) {
  void runAskpass({
    prompt: process.argv[2] ?? "",
    env: process.env,
    write: (text) => process.stdout.write(text),
  }).then((code) => {
    process.exitCode = code;
  });
}
