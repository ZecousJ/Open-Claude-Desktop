import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createServer, type Socket } from "node:net";
import { z } from "zod";
import { listenOnLoopback } from "../loopback-ports";

const frameLimit = 256 * 1024;
const nonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const hello = z.strictObject({ type: z.literal("hello"), nonce });
const confirm = z.strictObject({
  type: z.literal("confirm"),
  nonce,
  proof: nonce,
});
const sharedPage = z.strictObject({
  type: z.literal("shared"),
  version: z.literal(1),
  origin: z
    .string()
    .url()
    .max(2048)
    .refine((address) => {
      const url = new URL(address);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.origin === address
      );
    }),
  title: z.string().max(512),
});

const control = {
  revision: z.string().regex(/^[0-9a-f]{32}$/),
  index: z.number().int().min(0).max(127),
};
export const chromeArguments = {
  inspect: z.strictObject({}),
  click: z.strictObject(control),
  fill: z.strictObject({
    ...control,
    text: z.string().max(4000),
  }),
  scroll: z.strictObject({
    pixels: z.number().int().min(-2000).max(2000),
  }),
};
export const chromeOperation = z.discriminatedUnion("operation", [
  chromeArguments.inspect.extend({ operation: z.literal("inspect") }),
  chromeArguments.click.extend({ operation: z.literal("click") }),
  chromeArguments.fill.extend({ operation: z.literal("fill") }),
  chromeArguments.scroll.extend({ operation: z.literal("scroll") }),
]);
export type ChromeOperation = z.infer<typeof chromeOperation>;

const operationResults = {
  inspect: z.strictObject({
    revision: control.revision,
    url: z.string().max(8192),
    title: z.string().max(512),
    text: z.string().max(12_000),
    controls: z
      .array(
        z.strictObject({
          index: control.index,
          label: z.string().max(200),
          type: z.string().max(80),
        }),
      )
      .max(128),
  }),
  click: z.strictObject({ applied: z.literal(true) }),
  fill: z.strictObject({ applied: z.literal(true) }),
  scroll: z.strictObject({ scrollY: z.number().finite() }),
};
const operationReply = z.union([
  z.strictObject({
    type: z.literal("reply"),
    id: z.string().uuid(),
    value: z.unknown(),
  }),
  z.strictObject({
    type: z.literal("reply"),
    id: z.string().uuid(),
    error: z.string().max(500),
  }),
]);

export interface ChromeSharedPage {
  readonly id: string;
  readonly origin: string;
  readonly title: string;
}

interface SelectedPage extends ChromeSharedPage {
  socket: Socket;
  pending?: {
    id: string;
    operation: ChromeOperation["operation"];
    complete(error?: Error, value?: unknown): void;
  };
}

async function* messages(socket: Socket): AsyncGenerator<unknown> {
  let buffered = Buffer.alloc(0);
  for await (const chunk of socket) {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32LE(0);
      if (length < 1 || length > frameLimit)
        throw Error("Invalid Chrome message size.");
      if (buffered.length < length + 4) break;
      yield JSON.parse(buffered.subarray(4, length + 4).toString("utf8"));
      buffered = buffered.subarray(length + 4);
    }
  }
}

function send(socket: Socket, value: unknown) {
  const frame = Buffer.from(JSON.stringify(value));
  const packet = Buffer.alloc(4 + frame.length);
  packet.writeUInt32LE(frame.length);
  frame.copy(packet, 4);
  socket.write(packet);
}

/** One native Chrome connection and one explicitly shared document per account activation. */
export class ChromeExtensionBridge {
  private readonly key = randomBytes(32);
  private readonly sockets = new Set<Socket>();
  private readonly server = createServer((socket) => {
    this.sockets.add(socket);
    // A local incompatible or abandoned peer must release its slot.
    socket.setTimeout(5000, () => socket.destroy());
    const disconnected = () => {
      this.sockets.delete(socket);
      if (this.selected?.socket === socket) this.revoke();
    };
    socket.once("close", disconnected);
    void this.connect(socket).catch(() => socket.destroy());
  });
  private selected?: SelectedPage;

  constructor(private readonly pageChanged = () => {}) {}

  async start() {
    this.server.maxConnections = 6;
    return {
      port: await listenOnLoopback(this.server),
      key: this.key.toString("base64url"),
    };
  }

  page(): ChromeSharedPage | undefined {
    if (!this.selected) return undefined;
    const { id, origin, title } = this.selected;
    return { id, origin, title };
  }

  revoke() {
    const previous = this.selected;
    this.selected = undefined;
    previous?.pending?.complete(Error("Chrome stopped sharing this tab."));
    previous?.socket.destroy();
    if (previous) this.pageChanged();
  }

  close() {
    this.revoke();
    for (const socket of this.sockets) socket.destroy();
    this.server.close();
  }

  request(pageId: string, operation: ChromeOperation, signal: AbortSignal) {
    const page = this.selected;
    if (!page || page.id !== pageId || page.socket.destroyed)
      throw Error("Share the Chrome tab from its toolbar first.");
    if (page.pending) throw Error("Another Chrome action is running.");
    signal.throwIfAborted();
    return new Promise<unknown>((resolve, reject) => {
      const clear = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        page.pending = undefined;
      };
      const finish = (error?: Error, value?: unknown) => {
        clear();
        if (error) reject(error);
        else resolve(value);
      };
      const cancel = () => {
        finish(
          Error("The Chrome action ended before its result was confirmed."),
        );
        if (this.selected === page) this.revoke();
      };
      const timer = setTimeout(cancel, 15_000);
      signal.addEventListener("abort", cancel, { once: true });
      const id = randomUUID();
      page.pending = { id, operation: operation.operation, complete: finish };
      send(page.socket, { type: "request", id, ...operation });
    });
  }

  private async connect(socket: Socket) {
    const frames = messages(socket);
    const hostNonce = hello.parse((await frames.next()).value).nonce;
    const desktopNonce = randomBytes(32).toString("base64url");
    const proof = (peer: "desktop" | "host") =>
      createHmac("sha256", this.key)
        .update(`claudex-chrome-v1:${peer}:${hostNonce}:${desktopNonce}`)
        .digest();
    send(socket, {
      type: "challenge",
      nonce: desktopNonce,
      proof: proof("desktop").toString("base64url"),
    });
    const response = confirm.parse((await frames.next()).value);
    const supplied = Buffer.from(response.proof, "base64url");
    if (
      response.nonce !== desktopNonce ||
      supplied.length !== 32 ||
      !timingSafeEqual(supplied, proof("host"))
    )
      throw Error("Could not authenticate the Chrome native host.");

    const page = sharedPage.parse((await frames.next()).value);
    if (socket.destroyed) return;
    socket.setTimeout(0);
    this.revoke();
    const selected: SelectedPage = {
      id: randomUUID(),
      origin: page.origin,
      title: page.title,
      socket,
    };
    this.selected = selected;
    send(socket, { type: "ready" });
    this.pageChanged();
    for await (const message of frames) {
      if (this.selected !== selected) return;
      const reply = operationReply.parse(message);
      const pending = selected.pending;
      if (pending?.id !== reply.id)
        throw Error("Chrome replied to an unknown request.");
      if ("error" in reply) pending.complete(Error(reply.error));
      else
        pending.complete(
          undefined,
          operationResults[pending.operation].parse(reply.value),
        );
    }
  }
}
