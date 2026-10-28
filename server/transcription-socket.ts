/**
 * A small WebSocket client (RFC 6455) for realtime dictation (package C6).
 * It is written on `node:http` rather than the built-in `WebSocket` so a
 * refused upgrade keeps its HTTP status and body: the Claudex gateway
 * answers limits, revoked keys and required updates that way, and the
 * provider service turns them into the same refusals as a chat request.
 */
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";

const acceptGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** Largest message the service may send; transcripts are far smaller. */
export const maxSocketMessageBytes = 1024 * 1024;
const maxRefusalBody = 128 * 1024;

export const Opcode = {
  Continuation: 0,
  Text: 1,
  Binary: 2,
  Close: 8,
  Ping: 9,
  Pong: 10,
} as const;
export type Opcode = (typeof Opcode)[keyof typeof Opcode];

/** One frame; client frames are masked (`mask`), server frames are not. */
export function encodeFrame(
  opcode: Opcode,
  payload: Uint8Array,
  mask: boolean,
) {
  const length = payload.byteLength;
  const extra = length < 126 ? 0 : length < 65536 ? 2 : 8;
  const header = Buffer.alloc(2 + extra + (mask ? 4 : 0));
  header[0] = 0x80 | opcode;
  header[1] =
    (mask ? 0x80 : 0) | (extra === 0 ? length : extra === 2 ? 126 : 127);
  if (extra === 2) header.writeUInt16BE(length, 2);
  if (extra === 8) header.writeBigUInt64BE(BigInt(length), 2);
  const body = Buffer.from(payload);
  if (mask) {
    const key = randomBytes(4);
    key.copy(header, 2 + extra);
    for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3];
  }
  return Buffer.concat([header, body]);
}

export interface Frame {
  opcode: Opcode;
  fin: boolean;
  payload: Buffer;
}

/** Splits a byte stream into frames; throws on frames larger than the limit. */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): Frame[] {
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, chunk])
      : chunk;
    const frames: Frame[] = [];
    while (this.buffer.length >= 2) {
      const first = this.buffer[0],
        second = this.buffer[1];
      let length = second & 0x7f,
        offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) break;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) break;
        const long = this.buffer.readBigUInt64BE(2);
        if (long > BigInt(maxSocketMessageBytes))
          throw Error("The service sent a message that is too large.");
        length = Number(long);
        offset = 10;
      }
      if (length > maxSocketMessageBytes)
        throw Error("The service sent a message that is too large.");
      const masked = (second & 0x80) !== 0;
      const start = offset + (masked ? 4 : 0);
      if (this.buffer.length < start + length) break;
      const payload = Buffer.from(this.buffer.subarray(start, start + length));
      if (masked) {
        const key = this.buffer.subarray(offset, offset + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
      }
      frames.push({
        opcode: (first & 0x0f) as Opcode,
        fin: (first & 0x80) !== 0,
        payload,
      });
      this.buffer = this.buffer.subarray(start + length);
    }
    return frames;
  }
}

/** The service refused the upgrade with an ordinary HTTP answer. */
export class SocketRefused extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`The service refused dictation (HTTP ${status}).`);
  }
}

export interface SocketHandlers {
  onText(text: string): void;
  /** The connection ended; `code` 1005 when the service gave none. */
  onClose(code: number, reason: string): void;
  onError(error: Error): void;
}

/** An open connection: send text or binary messages, then close. */
export class TranscriptionSocket {
  private closed = false;
  private reader = new FrameReader();
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  constructor(
    private socket: Duplex,
    private handlers: SocketHandlers,
    head: Buffer,
  ) {
    socket.on("data", (chunk: Buffer) => this.read(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.finish(1006, ""));
    if (head.length) queueMicrotask(() => this.read(head));
  }
  get open() {
    return !this.closed;
  }
  sendText(text: string) {
    this.write(Opcode.Text, Buffer.from(text, "utf8"));
  }
  sendBinary(data: Uint8Array) {
    this.write(Opcode.Binary, data);
  }
  close(code = 1000) {
    if (this.closed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    this.write(Opcode.Close, payload);
    this.closed = true;
    this.socket.end();
    // A service that never answers the close frame is not waited for.
    setTimeout(() => this.socket.destroy(), 2000).unref();
  }
  /** Drops the connection without the closing handshake. */
  destroy() {
    this.closed = true;
    this.socket.destroy();
  }
  private write(opcode: Opcode, payload: Uint8Array) {
    if (this.closed) throw Error("Dictation is no longer connected.");
    this.socket.write(encodeFrame(opcode, payload, true));
  }
  private read(chunk: Buffer) {
    let frames: Frame[];
    try {
      frames = this.reader.push(chunk);
    } catch (error) {
      this.fail(error as Error);
      return;
    }
    for (const frame of frames) {
      if (frame.opcode === Opcode.Ping) {
        if (!this.closed)
          this.socket.write(encodeFrame(Opcode.Pong, frame.payload, true));
      } else if (frame.opcode === Opcode.Close) {
        const code =
          frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
        const reason = frame.payload.subarray(2).toString("utf8");
        if (!this.closed) {
          this.closed = true;
          this.socket.end(
            encodeFrame(Opcode.Close, frame.payload.subarray(0, 2), true),
          );
        }
        this.finish(code, reason);
        return;
      } else if (
        frame.opcode === Opcode.Text ||
        frame.opcode === Opcode.Binary ||
        frame.opcode === Opcode.Continuation
      ) {
        if (frame.opcode !== Opcode.Continuation) {
          this.fragments = [];
          this.fragmentBytes = 0;
        }
        this.fragments.push(frame.payload);
        this.fragmentBytes += frame.payload.length;
        if (this.fragmentBytes > maxSocketMessageBytes) {
          this.fail(Error("The service sent a message that is too large."));
          return;
        }
        if (!frame.fin) continue;
        const message = Buffer.concat(this.fragments);
        this.fragments = [];
        this.fragmentBytes = 0;
        // The service speaks JSON; a binary message is not part of the protocol.
        if (frame.opcode !== Opcode.Binary || message.length)
          this.handlers.onText(message.toString("utf8"));
      }
    }
  }
  private ended = false;
  private finish(code: number, reason: string) {
    if (this.ended) return;
    this.ended = true;
    this.closed = true;
    this.handlers.onClose(code, reason);
  }
  private fail(error: Error) {
    if (this.ended) return;
    this.handlers.onError(error);
    this.destroy();
    this.finish(1006, "");
  }
}

/**
 * Opens a WebSocket to an http(s) URL (sent as ws/wss). Rejects with
 * `SocketRefused` when the service answers the upgrade with HTTP.
 */
export function connectTranscriptionSocket(
  url: string,
  headers: Record<string, string>,
  handlers: SocketHandlers,
  timeoutMs = 15_000,
): Promise<TranscriptionSocket> {
  const target = new URL(url);
  if (!["http:", "https:"].includes(target.protocol))
    throw Error("Dictation needs an http(s) service address.");
  const key = randomBytes(16).toString("base64");
  const expected = createHash("sha1")
    .update(key + acceptGuid)
    .digest("base64");
  const request = (target.protocol === "https:" ? https : http).request(
    target,
    {
      method: "GET",
      headers: {
        ...headers,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
      },
      timeout: timeoutMs,
    },
  );
  return new Promise((resolve, reject) => {
    request.on("upgrade", (response, socket, head) => {
      if (response.headers["sec-websocket-accept"] !== expected) {
        socket.destroy();
        reject(Error("The service's dictation connection is not valid."));
        return;
      }
      socket.setNoDelay?.(true);
      request.setTimeout(0);
      resolve(new TranscriptionSocket(socket, handlers, head));
    });
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        if (bytes >= maxRefusalBody) return;
        bytes += chunk.length;
        chunks.push(chunk);
      });
      response.on("end", () =>
        reject(
          new SocketRefused(
            response.statusCode ?? 502,
            Buffer.concat(chunks).subarray(0, maxRefusalBody).toString("utf8"),
          ),
        ),
      );
      response.on("error", reject);
    });
    request.on("timeout", () => {
      request.destroy(Error("The dictation service did not answer."));
    });
    request.on("error", reject);
    request.end();
  });
}
