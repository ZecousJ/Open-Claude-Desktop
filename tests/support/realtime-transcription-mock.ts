/**
 * A stand-in for the Claudex service's realtime dictation WebSocket
 * (`/v1/audio/realtime/transcriptions`, owner decision 18) and for the
 * one-file `/v1/audio/transcriptions`, for tests (package C6; I2 may reuse
 * it). The transcript messages follow the shapes the client reads; the
 * provider's exact names are not confirmed yet.
 */
import { createHash } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import {
  encodeFrame,
  FrameReader,
  Opcode,
} from "../../server/transcription-socket";

export interface RealtimeSession {
  authorization: string;
  headers: http.IncomingHttpHeaders;
  start?: Record<string, any>;
  finish?: Record<string, any>;
  audioBytes: number;
  chunks: number;
  /** Sends a JSON message to the client. */
  send(message: unknown): void;
  close(code?: number, reason?: string): void;
}

export interface RealtimeMockOptions {
  /** The key the service accepts; others get 401. */
  key: string;
  /** Answer the upgrade with this HTTP status and body instead. */
  refuse?: { status: number; body: unknown };
  /** Called for every audio chunk; the default sends a partial every 3200 bytes. */
  onAudio?(session: RealtimeSession): void;
  /** Called on `finish`; the default sends a final and a done message. */
  onFinish?(session: RealtimeSession): void;
  /** What `POST /v1/audio/transcriptions` returns. */
  transcript?: string;
}

const guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class RealtimeTranscriptionMock {
  readonly sessions: RealtimeSession[] = [];
  readonly uploads: { authorization: string; body: Buffer }[] = [];
  private server: http.Server;
  private sockets = new Set<Duplex>();
  url = "";
  constructor(private options: RealtimeMockOptions) {
    this.server = http.createServer((req, res) => void this.upload(req, res));
    this.server.on("upgrade", (req, socket, head) =>
      this.upgrade(req, socket, head),
    );
  }
  async start() {
    await new Promise<void>((resolve) =>
      this.server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${port}/v1`;
    return this;
  }
  async stop() {
    for (const socket of this.sockets) socket.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
  private async upload(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (req.url !== "/v1/audio/transcriptions") {
      res.writeHead(404).end();
      return;
    }
    this.uploads.push({
      authorization: String(req.headers.authorization ?? ""),
      body: Buffer.concat(chunks),
    });
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify({ text: this.options.transcript ?? "Uploaded words" }),
      );
  }
  private upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    const reject = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      socket.end(
        `HTTP/1.1 ${status} Refused\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`,
      );
    };
    if (req.url !== "/v1/audio/realtime/transcriptions")
      return reject(404, { code: "NOT_FOUND", message: "Not found" });
    if (this.options.refuse)
      return reject(this.options.refuse.status, this.options.refuse.body);
    const authorization = String(req.headers.authorization ?? "");
    if (authorization !== `Bearer ${this.options.key}`)
      return reject(401, {
        code: "INVALID_API_KEY",
        message: "Invalid API key",
      });
    const accept = createHash("sha1")
      .update(String(req.headers["sec-websocket-key"]) + guid)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => {});
    const session: RealtimeSession = {
      authorization,
      headers: req.headers,
      audioBytes: 0,
      chunks: 0,
      send: (message) => {
        if (!socket.destroyed)
          socket.write(
            encodeFrame(
              Opcode.Text,
              Buffer.from(JSON.stringify(message)),
              false,
            ),
          );
      },
      close: (code = 1000, reason = "") => {
        if (socket.destroyed) return;
        const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
        payload.writeUInt16BE(code);
        payload.write(reason, 2);
        socket.end(encodeFrame(Opcode.Close, payload, false));
      },
    };
    this.sessions.push(session);
    const reader = new FrameReader();
    const read = (chunk: Buffer) => {
      for (const frame of reader.push(chunk)) {
        if (frame.opcode === Opcode.Binary) {
          session.audioBytes += frame.payload.length;
          session.chunks++;
          if (this.options.onAudio) this.options.onAudio(session);
          else if (session.audioBytes % 3200 === 0)
            session.send({
              type: "transcript.partial",
              requestId: session.start?.requestId,
              text: `heard ${session.audioBytes / 3200}`,
            });
        } else if (frame.opcode === Opcode.Text) {
          const message = JSON.parse(frame.payload.toString("utf8"));
          if (message.type === "start") session.start = message;
          if (message.type === "finish") {
            session.finish = message;
            if (this.options.onFinish) this.options.onFinish(session);
            else {
              session.send({
                type: "transcript.final",
                requestId: message.requestId,
                text: "Hello from the microphone.",
              });
              session.send({
                type: "transcript.done",
                requestId: message.requestId,
              });
            }
          }
        } else if (frame.opcode === Opcode.Close) {
          socket.end(
            encodeFrame(Opcode.Close, frame.payload.subarray(0, 2), false),
          );
        }
      }
    };
    socket.on("data", read);
    if (head.length) read(head);
  }
}
