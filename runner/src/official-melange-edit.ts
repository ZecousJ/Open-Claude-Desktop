import type http from "node:http";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import type { WebAppContext } from "./web-app-context";
import type { OfficialUiReadResponse } from "../../shared/official-ui-web";

const streamType = "text/event-stream";
const chunkBytes = 64 * 1024;
const maxStreamBytes = 1024 * 1024;
const leaseMs = 2 * 60_000;
const failed = Buffer.from(
  'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Memory edit failed."}}\n\n',
);

function error(status: number, message: string): OfficialUiReadResponse {
  return {
    status,
    contentType: "application/json",
    body: Buffer.from(
      JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message },
      }),
    ),
  };
}

class EditResponse extends Writable {
  status = 0;
  headers: Record<string, string> = {};
  headersSent = false;
  bytes = 0;
  chunks: Buffer[] = [];
  private resolveReady!: () => void;
  readonly ready = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });

  constructor() {
    super();
    this.on("error", () => {});
    this.once("close", () => {
      this.resolveReady();
      if (this.streaming && !this.writableFinished) {
        this.chunks.push(failed);
        this.bytes += failed.length;
      }
    });
  }

  get streaming() {
    return (
      this.status === 200 &&
      this.headers["Content-Type"]?.startsWith(streamType) === true
    );
  }

  writeHead(status: number, headers: Record<string, string>) {
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
    this.resolveReady();
    return this;
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ) {
    if (this.bytes + chunk.length > maxStreamBytes)
      return done(Error("Memory edit response is too large."));
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    done();
  }

  readChunk(cursor: number) {
    const parts: Buffer[] = [];
    let skip = cursor,
      remaining = chunkBytes;
    for (const chunk of this.chunks) {
      if (skip >= chunk.length) {
        skip -= chunk.length;
        continue;
      }
      const part = chunk.subarray(skip, skip + remaining);
      parts.push(part);
      remaining -= part.length;
      if (!remaining) break;
      skip = 0;
    }
    return Buffer.concat(parts, chunkBytes - remaining);
  }
}

export type MelangeEditOwner = {
  activation: unknown;
  tab: string;
  session: string;
};

type Edit = {
  owner: MelangeEditOwner;
  current(): boolean;
  response: EditResponse;
  timer: ReturnType<typeof setTimeout>;
};

class Edits {
  private operations = new Map<string, Edit>();

  private remove(id: string, edit: Edit) {
    if (this.operations.get(id) !== edit) return;
    clearTimeout(edit.timer);
    edit.response.destroy();
    this.operations.delete(id);
  }

  close(tab?: string) {
    for (const [id, edit] of this.operations)
      if (tab === undefined || edit.owner.tab === tab) this.remove(id, edit);
  }

  async start(
    id: string,
    owner: MelangeEditOwner,
    current: () => boolean,
    run: (response: http.ServerResponse) => Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<OfficialUiReadResponse> {
    if (this.operations.has(id) || this.operations.size >= 8)
      return error(409, "Too many memory edits are open.");
    signal?.throwIfAborted();
    const response = new EditResponse();
    const timer = setTimeout(() => this.remove(id, edit), leaseMs);
    timer.unref();
    const edit = { owner, current, response, timer };
    this.operations.set(id, edit);
    const abort = () => this.remove(id, edit);
    signal?.addEventListener("abort", abort, { once: true });
    const execution = run(response as unknown as http.ServerResponse).then(
      (handled) => {
        if (!handled || !response.writableEnded) response.destroy();
      },
      () => response.destroy(),
    );
    try {
      await response.ready;
      signal?.throwIfAborted();
      if (!current()) return error(409, "The account activation changed.");
      if (response.streaming)
        return { status: 202, contentType: streamType, body: Buffer.alloc(0) };
      await execution;
      await finished(response, { cleanup: true }).catch(() => {});
      if (response.status >= 400 && response.writableFinished)
        return {
          status: response.status,
          contentType: response.headers["Content-Type"],
          body: Buffer.concat(response.chunks),
        };
      return error(503, "Memory edit could not be started.");
    } finally {
      signal?.removeEventListener("abort", abort);
      if (!response.streaming || !current()) this.remove(id, edit);
    }
  }

  private find(id: string, owner: MelangeEditOwner) {
    const edit = this.operations.get(id);
    if (
      edit &&
      edit.owner.activation === owner.activation &&
      edit.owner.session === owner.session &&
      edit.owner.tab === owner.tab
    )
      return edit;
  }

  poll(
    id: string,
    owner: MelangeEditOwner,
    cursor: number,
  ): OfficialUiReadResponse {
    const edit = this.find(id, owner);
    if (!edit) return error(404, "Memory edit is unavailable.");
    if (!edit.current()) {
      this.remove(id, edit);
      return error(409, "The account activation changed.");
    }
    const { response } = edit;
    if (!response.streaming || cursor > response.bytes)
      return error(400, "Invalid memory edit cursor.");
    edit.timer.refresh();
    const body = response.readChunk(cursor);
    const done =
      (response.writableFinished || response.closed) &&
      cursor + body.length === response.bytes;
    if (done) this.remove(id, edit);
    return {
      status: done ? 200 : body.length ? 206 : 202,
      contentType: streamType,
      body,
    };
  }

  stop(id: string, owner: MelangeEditOwner): OfficialUiReadResponse {
    const edit = this.find(id, owner);
    if (edit) this.remove(id, edit);
    return {
      status: 204,
      contentType: "application/json",
      body: Buffer.alloc(0),
    };
  }
}

const edits = new WeakMap<WebAppContext, Edits>();

export function officialMelangeEdits(ctx: WebAppContext) {
  let current = edits.get(ctx);
  if (!current) {
    current = new Edits();
    edits.set(ctx, current);
  }
  return current;
}

export function closeOfficialMelangeEdits(ctx: WebAppContext, tab?: string) {
  edits.get(ctx)?.close(tab);
}
