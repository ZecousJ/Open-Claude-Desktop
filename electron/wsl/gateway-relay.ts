import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";

const id = z.number().int().positive();
const frame = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ready"),
    port: z.number().int().min(1).max(65535),
  }),
  z.object({ kind: z.literal("open"), id }),
  z.object({ kind: z.literal("data"), id, data: z.string() }),
  z.object({ kind: z.literal("end"), id }),
  z.object({ kind: z.literal("close"), id }),
]);

export async function startWslGateway(
  child: ChildProcessWithoutNullStreams,
  gatewayPort: number,
) {
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const sockets = new Map<number, Socket>();
  const blocked = new Set<Socket>();
  let stopped = false;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  function stop() {
    if (stopped) return;
    stopped = true;
    resolveClosed();
    lines.close();
    for (const socket of sockets.values()) socket.destroy();
    sockets.clear();
    child.stdin.end();
  }

  function send(msg: z.infer<typeof frame>) {
    if (stopped) return;
    if (!child.stdin.write(JSON.stringify(msg) + "\n")) {
      for (const socket of sockets.values()) socket.pause();
    }
  }

  child.stderr.resume();
  child.stdin.on("error", stop);
  child.once("error", stop);
  child.once("close", stop);
  lines.once("close", stop);
  child.stdin.on("drain", () => {
    for (const socket of sockets.values()) socket.resume();
  });

  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("The WSL gateway did not start."));
      }, 15_000);
      void closed.then(() => {
        clearTimeout(timer);
        reject(new Error("The WSL gateway stopped."));
      });
      lines.on("line", (line) => {
        let parsed;
        try {
          parsed = frame.safeParse(JSON.parse(line));
        } catch {
          stop();
          return;
        }
        if (!parsed.success) {
          stop();
          return;
        }
        const msg = parsed.data;
        if (msg.kind === "ready") {
          clearTimeout(timer);
          resolve(msg.port);
          return;
        }
        if (msg.kind === "open") {
          const socket = createConnection({
            host: "127.0.0.1",
            port: gatewayPort,
            allowHalfOpen: true,
          });
          sockets.set(msg.id, socket);
          socket.on("data", (data: Buffer) => {
            send({ kind: "data", id: msg.id, data: data.toString("base64") });
          });
          socket.on("end", () => send({ kind: "end", id: msg.id }));
          socket.on("error", () => socket.destroy());
          const unblock = () => {
            if (blocked.delete(socket) && !blocked.size && !stopped)
              lines.resume();
          };
          socket.on("drain", unblock);
          socket.once("close", () => {
            unblock();
            if (sockets.delete(msg.id)) send({ kind: "close", id: msg.id });
          });
          if (child.stdin.writableNeedDrain) socket.pause();
          return;
        }
        const socket = sockets.get(msg.id);
        if (!socket) return;
        if (msg.kind === "data") {
          if (!socket.write(Buffer.from(msg.data, "base64"))) {
            blocked.add(socket);
            lines.pause();
          }
        } else if (msg.kind === "end") {
          socket.end();
        } else {
          sockets.delete(msg.id);
          socket.destroy();
        }
      });
    });
    return { port, closed, stop };
  } catch (error) {
    stop();
    throw error;
  }
}
