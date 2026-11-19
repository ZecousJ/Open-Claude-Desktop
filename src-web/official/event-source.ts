/** Finite MCP discovery SSE over the authenticated runner read channel.
 * This is not a general EventSource proxy: unrelated URLs retain the browser's
 * native transport and its origin/CSP rules. No automatic retry or vendor relay.
 */
import {
  officialUiReadMaxBytes,
  type OfficialUiReadRequest,
  type OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import { officialFrameByteLength } from "./frame-lifecycle";
import type { TimelineEvents } from "./timeline-fetch";

type Read = (request: OfficialUiReadRequest) => Promise<OfficialUiReadResponse>;
const bootstrap =
  /^\/api\/organizations\/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\/mcp\/v2\/bootstrap$/i;
const names = new Set([
  "server_list",
  "server_base",
  "tools",
  "resources",
  "skills",
  "first_pass_complete",
  "completed",
  "message",
]);

/** Validate the entire finite answer before publishing any partial inventory. */
function parse(answer: OfficialUiReadResponse) {
  if (
    answer.status !== 200 ||
    !/^text\/event-stream(?:\s*;|$)/i.test(answer.contentType) ||
    officialFrameByteLength(answer.body) > officialUiReadMaxBytes
  )
    throw Error("Invalid MCP bootstrap response.");
  const text = new TextDecoder("utf-8", { fatal: true })
    .decode(answer.body)
    .replace(/\r\n?/g, "\n");
  const events: { type: string; data: string; id: string }[] = [];
  let type = "",
    data: string[] = [],
    id = "";
  for (const line of text.split("\n")) {
    if (!line) {
      if (data.length) {
        const name = type || "message",
          value = data.join("\n");
        if (!names.has(name)) throw Error("Unsupported MCP bootstrap event.");
        const payload = JSON.parse(value);
        if (!payload || typeof payload !== "object" || Array.isArray(payload))
          throw Error("Invalid MCP bootstrap payload.");
        if (name === "server_list" && !Array.isArray(payload.servers))
          throw Error("Invalid MCP server inventory.");
        if (
          name === "skills" &&
          (typeof payload.server_uuid !== "string" ||
            !Array.isArray(payload.skills))
        )
          throw Error("Invalid MCP skill inventory.");
        events.push({ type: name, data: value, id });
      } else if (type) throw Error("Missing MCP bootstrap data.");
      type = "";
      data = [];
      continue;
    }
    if (line.startsWith(":")) continue;
    const split = line.indexOf(":"),
      key = split < 0 ? line : line.slice(0, split);
    let value = split < 0 ? "" : line.slice(split + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (key === "event") type = value;
    else if (key === "data") data.push(value);
    else if (key === "id") {
      if (!value.includes("\0")) id = value;
    } else if (key === "retry" && /^\d+$/.test(value)) {
      /* finite stream deliberately never reconnects */
    } else throw Error("Invalid MCP bootstrap event field.");
  }
  if (
    data.length ||
    type ||
    events[0]?.type !== "server_list" ||
    events.at(-1)?.type !== "completed" ||
    events.filter((event) => event.type === "completed").length !== 1 ||
    events.filter((event) => event.type === "server_list").length !== 1 ||
    !events.some((event) => event.type === "first_pass_complete")
  )
    throw Error("Incomplete MCP bootstrap stream.");
  return events;
}

export function createOfficialEventSource(
  origin: string,
  read: Read,
  NativeEventSource: typeof EventSource,
  subscribe: TimelineEvents,
  options: { timeoutMs?: number } = {},
): typeof EventSource {
  const base = new URL(origin).origin;
  class OfficialEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readonly url: string;
    readonly withCredentials: boolean;
    onopen: EventSource["onopen"] = null;
    onerror: EventSource["onerror"] = null;
    onmessage: EventSource["onmessage"] = null;
    private state = 0;
    private unsubscribe = () => {};
    private timer: ReturnType<typeof setTimeout> | undefined;
    get readyState() {
      return this.state;
    }

    constructor(input: string | URL, init?: EventSourceInit) {
      super();
      const url = new URL(String(input), base);
      this.url = url.href;
      this.withCredentials = !!init?.withCredentials;
      if (
        url.origin !== base ||
        url.username ||
        url.password ||
        !bootstrap.test(url.pathname) ||
        url.search ||
        url.hash
      )
        return new NativeEventSource(
          input,
          init,
        ) as unknown as OfficialEventSource;
      this.addEventListener("open", (event) =>
        this.onopen?.call(this as unknown as EventSource, event),
      );
      this.addEventListener("error", (event) =>
        this.onerror?.call(this as unknown as EventSource, event),
      );
      this.addEventListener("message", (event) =>
        this.onmessage?.call(
          this as unknown as EventSource,
          event as MessageEvent,
        ),
      );
      // Match EventSource asynchronous opening: callers can register handlers or
      // close immediately before any authenticated work is started.
      queueMicrotask(() => {
        void this.open(url.pathname);
      });
    }

    close() {
      if (this.state === this.CLOSED) return;
      this.state = this.CLOSED;
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.unsubscribe();
      this.unsubscribe = () => {};
    }

    private fail() {
      if (this.state === this.CLOSED) return;
      this.close();
      this.dispatchEvent(new Event("error"));
    }

    private async open(path: string) {
      if (this.state === this.CLOSED) return;
      try {
        this.unsubscribe = subscribe((event) => {
          if (event.type === "signed-out") this.close();
        });
        // Subscription may synchronously report an already-ended session.
        if (this.state === this.CLOSED) {
          this.unsubscribe();
          return;
        }
        this.timer = setTimeout(() => this.fail(), options.timeoutMs ?? 30_000);
        const answer = await read({ method: "GET", path });
        if (this.state === this.CLOSED) return;
        const events = parse(answer);
        this.state = this.OPEN;
        this.dispatchEvent(new Event("open"));
        for (const event of events) {
          if (this.state === this.CLOSED) return;
          this.dispatchEvent(
            new MessageEvent(event.type, {
              data: event.data,
              origin: base,
              lastEventId: event.id,
            }),
          );
        }
        this.close();
      } catch {
        this.fail();
      }
    }
  }
  return OfficialEventSource as unknown as typeof EventSource;
}
