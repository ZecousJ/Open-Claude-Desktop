/**
 * Shared set-up of the runner-core tests (no tests of its own).
 *
 * `useElectronShim()` maps "electron" to runner/src/electron-shim.ts, as the
 * runner bundle does, so the desktop IPC domains load under plain Node. Call
 * it before importing (dynamically) anything that imports "electron".
 */
import module from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";

let installed = false;
/**
 * Also makes `process.platform` read "linux": the runner only runs on Linux,
 * and desktop domains take macOS-only paths at registration.
 */
export function useElectronShim() {
  if (installed) return;
  installed = true;
  Object.defineProperty(process, "platform", {
    value: "linux",
    configurable: true,
  });
  const shim = pathToFileURL(
    fileURLToPath(
      new URL("../../runner/src/electron-shim.ts", import.meta.url),
    ),
  ).href;
  (module as any).registerHooks({
    resolve(specifier: string, context: unknown, next: Function) {
      if (specifier === "electron") return { url: shim, shortCircuit: true };
      return next(specifier, context);
    },
  });
}

// ---------------------------------------------------------------------------
// An in-memory webstore answering the runner's store.* ops the way W-STORE
// must (runner/src/cloud-store.ts header), paged `pageSize` rows at a time.

export interface MemoryWebstore {
  request(op: string, userId: number, body?: any): Promise<unknown>;
  users: Map<number, UserRows>;
  log: { op: string; userId: number; body: any }[];
  /** Makes the next matching request fail once. */
  failNext(op: string): void;
  files: Map<string, { userId: number; bytes: Uint8Array }>;
}
export interface UserRows {
  settings: object | null;
  projects: Map<string, { project: any; position: number }>;
  conversations: Map<string, { doc: any; position: number }>;
  turns: Map<string, Map<string, any>>;
}

export function memoryWebstore(pageSize = 2): MemoryWebstore {
  const users = new Map<number, UserRows>();
  const log: MemoryWebstore["log"] = [];
  const failing = new Set<string>();
  const files = new Map<string, { userId: number; bytes: Uint8Array }>();
  const rows = (userId: number) => {
    let found = users.get(userId);
    if (!found) {
      found = {
        settings: null,
        projects: new Map(),
        conversations: new Map(),
        turns: new Map(),
      };
      users.set(userId, found);
    }
    return found;
  };
  const page = <T>(list: T[], cursor?: string) => {
    const start = cursor ? Number(cursor) : 0;
    const items = list.slice(start, start + pageSize);
    const next =
      start + pageSize < list.length ? String(start + pageSize) : undefined;
    return { items, ...(next ? { next } : {}) };
  };
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  return {
    users,
    log,
    files,
    failNext: (op) => void failing.add(op),
    async request(op, userId, body: any = {}) {
      log.push({ op, userId, body: clone(body) });
      if (failing.delete(op)) throw new Error("webstore is down");
      const u = rows(userId);
      switch (op) {
        case "store.settings.get":
          return { settings: u.settings && clone(u.settings) };
        case "store.settings.put":
          u.settings = clone(body.settings);
          return {};
        case "store.projects.list":
          return {
            projects: [...u.projects.values()]
              .sort((a, b) => a.position - b.position)
              .map((row) => clone(row.project)),
          };
        case "store.projects.put":
          u.projects.set(body.project.id, clone(body));
          return {};
        case "store.projects.delete":
          u.projects.delete(body.id);
          return {};
        case "store.conversations.list": {
          const { items, next } = page(
            [...u.conversations.values()].sort(
              (a, b) => a.position - b.position,
            ),
            body.cursor,
          );
          return { items: clone(items), ...(next ? { next } : {}) };
        }
        case "store.conversations.put":
          u.conversations.set(body.doc.conversation.id, clone(body));
          if (!u.turns.has(body.doc.conversation.id))
            u.turns.set(body.doc.conversation.id, new Map());
          return {};
        case "store.conversations.delete":
          u.conversations.delete(body.id);
          u.turns.delete(body.id);
          return {};
        case "store.turns.list": {
          const list = [...(u.turns.get(body.conversationId)?.values() ?? [])];
          const { items, next } = page(list, body.cursor);
          return { turns: clone(items), ...(next ? { next } : {}) };
        }
        case "store.turns.put":
          for (const turn of body.turns) {
            if (!u.conversations.has(turn.conversationId))
              throw new Error("turn of an unknown conversation");
            u.turns
              .get(turn.conversationId)!
              .set(`${turn.branchId ?? ""}|${turn.turnId}`, clone(turn));
          }
          return {};
        case "store.turns.delete":
          for (const key of body.keys)
            u.turns
              .get(body.conversationId)
              ?.delete(`${key.branchId ?? ""}|${key.turnId}`);
          return {};
        case "store.files.get": {
          const file = files.get(body.id);
          if (!file || file.userId !== userId) throw new Error("no such file");
          const bytes = file.bytes.subarray(
            body.offset,
            body.offset + body.length,
          );
          return {
            size: file.bytes.byteLength,
            bytes: { $bytes: Buffer.from(bytes).toString("base64") },
          };
        }
        default:
          throw new Error(`unknown op ${op}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// A minimal WebSocket server (text frames only) for the real-socket link test.

export interface TestSocket {
  headers: http.IncomingHttpHeaders;
  send(text: string): void;
  close(code?: number): void;
  onText?: (text: string) => void;
  onClose?: () => void;
}

export async function wsServer(
  accept: (socket: TestSocket) => void,
  protocol = "claudex.runner.v1",
) {
  const server = http.createServer();
  const sockets = acceptWebSockets(server, accept, protocol);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Answers WebSocket upgrades on an existing server; returns the open sockets. */
export function acceptWebSockets(
  server: http.Server,
  accept: (socket: TestSocket) => void,
  protocol = "claudex.runner.v1",
) {
  const sockets = new Set<import("node:net").Socket>();
  server.on("upgrade", (req, socket) => {
    sockets.add(socket as any);
    const key = req.headers["sec-websocket-key"] as string;
    const digest = crypto
      .createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${digest}\r\nSec-WebSocket-Protocol: ${protocol}\r\n\r\n`,
    );
    let buffer = Buffer.alloc(0);
    const frame = (opcode: number, payload: Buffer) => {
      const length = payload.length;
      const head =
        length < 126
          ? Buffer.from([0x80 | opcode, length])
          : length < 65536
            ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 255])
            : (() => {
                const b = Buffer.alloc(10);
                b[0] = 0x80 | opcode;
                b[1] = 127;
                b.writeBigUInt64BE(BigInt(length), 2);
                return b;
              })();
      socket.write(Buffer.concat([head, payload]));
    };
    const test: TestSocket = {
      headers: req.headers,
      send: (text) => frame(1, Buffer.from(text)),
      close: (code = 1000) => {
        const body = Buffer.alloc(2);
        body.writeUInt16BE(code);
        frame(8, body);
        socket.end();
      },
    };
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0]! & 15;
        let length = buffer[1]! & 127;
        let offset = 2;
        if (length === 126) {
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const masked = (buffer[1]! & 128) !== 0;
        const total = offset + (masked ? 4 : 0) + length;
        if (buffer.length < total) break;
        const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
        const payload = Buffer.from(
          buffer.subarray(offset + (masked ? 4 : 0), total),
        );
        if (mask)
          for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
        buffer = buffer.subarray(total);
        if (opcode === 1) test.onText?.(payload.toString());
        if (opcode === 8) {
          socket.end();
          test.onClose?.();
        }
      }
    });
    // The peer went away: nothing half-open keeps the server from closing.
    socket.on("end", () => socket.destroy());
    socket.on("close", () => {
      sockets.delete(socket as any);
      test.onClose?.();
    });
    accept(test);
  });
  return sockets;
}
