/** Adapt one durable runner submission plus read-only batches into real legacy SSE. */
import type { AppEvent } from "./types";
import { webErrorCodes } from "./web-protocol";
import type {
  OfficialUiReadRequest,
  OfficialUiReadResponse,
} from "./official-ui-web";
type TimelineEvents = (listener: (event: AppEvent) => void) => () => void;
type Bridge = (
  request: OfficialUiReadRequest,
) => Promise<OfficialUiReadResponse>;
const uuid =
  "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}";
export const completionPath = new RegExp(
  `^/api/organizations/(${uuid})/chat_conversations/(${uuid})/(?:completion|retry_completion2?)$`,
);
const operationId = new RegExp(`^${uuid}$`);
const eventNames = new Set([
  "message_start",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "content_block_retract",
  "mcp_auth_required",
  "message_delta",
  "message_stop",
  "conversation_ready",
  "error",
  "ping",
]);
const encoder = new TextEncoder();
const maxBytes = 4 * 1024 * 1024;
type Batch = {
  operation_id: string;
  cursor: number;
  events: { event: string; data: unknown }[];
  done: boolean;
};
function batch(answer: OfficialUiReadResponse, previous?: Batch): Batch {
  if (
    !/^application\/json(?:\s*;|$)/i.test(answer.contentType) ||
    answer.body.byteLength > 256 * 1024
  )
    throw Error("Invalid completion batch.");
  let value: Batch;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(answer.body),
    );
  } catch {
    throw Error("Invalid completion batch.");
  }
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.operation_id !== "string" ||
    !operationId.test(value.operation_id) ||
    !Number.isSafeInteger(value.cursor) ||
    value.cursor < 0 ||
    typeof value.done !== "boolean" ||
    !Array.isArray(value.events) ||
    value.events.length > 64
  )
    throw Error("Invalid completion batch.");
  if (!previous && value.cursor !== value.events.length)
    throw Error("Completion initial prefix is missing.");
  if (
    previous &&
    (value.operation_id !== previous.operation_id ||
      value.cursor < previous.cursor ||
      value.cursor !== previous.cursor + value.events.length)
  )
    throw Error("Completion cursor changed unexpectedly.");
  for (const entry of value.events)
    if (
      !entry ||
      !eventNames.has(entry.event) ||
      entry.data === null ||
      typeof entry.data !== "object" ||
      Array.isArray(entry.data) ||
      (entry.data as { type?: unknown }).type !== entry.event
    )
      throw Error("Invalid completion event.");
  const terminalIndexes = value.events.flatMap((e, index) =>
    e.event === "message_stop" || e.event === "error" ? [index] : [],
  );
  if (
    terminalIndexes.length > 1 ||
    (terminalIndexes.length === 1 &&
      terminalIndexes[0] !== value.events.length - 1)
  )
    throw Error("Completion terminal event must be unique and last.");
  const terminal = terminalIndexes.length === 1;
  // This bridge always starts at event zero and stops on its terminal event.
  // It never resumes at a previously consumed cursor: an empty done batch here
  // would hide the terminal reason. A backend may expose such a status read to
  // other callers, but it is not a valid continuation of this fresh stream.
  if (terminal !== value.done)
    throw Error("Completion termination is inconsistent.");
  return value;
}
function transientReadFailure(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === webErrorCodes.runnerUnavailable || error.code === webErrorCodes.timeout;
}
function eventBytes(events: Batch["events"]) {
  return encoder.encode(
    events
      .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
      .join(""),
  );
}
function errorEvent(message: string) {
  return eventBytes([
    {
      event: "error",
      data: { type: "error", error: { type: "api_error", message } },
    },
  ]);
}
/** Abort detaches the stream only; stopping an engine is an explicit separate action. */
export async function openOfficialCompletion(
  request: OfficialUiReadRequest,
  signal: AbortSignal,
  read: Bridge,
  action: Bridge,
  subscribe: TimelineEvents,
  options: { pollMs?: number; deadlineMs?: number } = {},
): Promise<Response> {
  const match = completionPath.exec(request.path);
  if (request.method !== "POST" || !match)
    throw Error("Invalid completion route.");
  let stopped = false,
    controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let unsubscribe = () => {},
    timer: ReturnType<typeof setTimeout> | undefined,
    deadline: ReturnType<typeof setTimeout> | undefined;
  let busy = false,
    dirty = false,
    current: Batch | undefined,
    total = 0;
  let rejectOpening!: (error: unknown) => void;
  const openingAbort = new Promise<never>((_, reject) => {
    rejectOpening = reject;
  });
  void openingAbort.catch(() => {});
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    try {
      unsubscribe();
    } catch {
      /* Host cleanup failure must not retain timers or replay a send. */
    }
    if (timer) clearTimeout(timer);
    if (deadline) clearTimeout(deadline);
    signal.removeEventListener("abort", abort);
  };
  const abort = () => {
    if (stopped) return;
    const error = new DOMException("The request was aborted.", "AbortError");
    if (controller) controller.error(error);
    else rejectOpening(error);
    cleanup();
  };
  const fail = (message: string) => {
    if (stopped) return;
    if (controller) {
      controller.enqueue(errorEvent(message));
      controller.close();
    } else rejectOpening(Error(message));
    cleanup();
  };
  const emit = (value: Batch) => {
    if (stopped) return;
    const bytes = eventBytes(value.events);
    total += bytes.length;
    if (total > maxBytes)
      throw Error("Completion stream exceeded its size limit.");
    if (bytes.length) controller!.enqueue(bytes);
    current = value;
    if (value.done) {
      controller!.close();
      cleanup();
    }
  };
  const schedule = () => {
    if (!stopped)
      timer = setTimeout(() => {
        dirty = true;
        pump();
      }, options.pollMs ?? 1000);
  };
  const pump = () => {
    if (
      stopped ||
      busy ||
      !dirty ||
      !controller ||
      !current ||
      current.done ||
      (controller.desiredSize ?? 0) <= 0
    )
      return;
    busy = true;
    dirty = false;
    if (timer) clearTimeout(timer);
    const path = `/api/organizations/${match[1]}/chat_conversations/${match[2]}/claudex_completion/${current.operation_id}?cursor=${current.cursor}`;
    void read({ method: "GET", path })
      .catch((error: unknown) => {
        if (transientReadFailure(error)) return undefined;
        throw error;
      })
      .then((answer) => {
        if (!answer) return;
        if (stopped) return;
        if (answer.status !== 200) {
          let message =
            "The completion stream could not be refreshed. Check the conversation before retrying.";
          try {
            const value = JSON.parse(new TextDecoder().decode(answer.body));
            const m = value?.error?.message ?? value?.error;
            if (typeof m === "string" && m.length <= 2000) message = m;
          } catch {}
          throw Error(message);
        }
        emit(batch(answer, current));
      })
      .catch((error) =>
        fail(
          error instanceof Error
            ? error.message
            : "The completion stream failed.",
        ),
      )
      .finally(() => {
        busy = false;
        if (!stopped) {
          if (dirty) pump();
          else schedule();
        }
      });
  };
  unsubscribe = subscribe((event: AppEvent) => {
    if (event.type === "signed-out") {
      abort();
      return;
    }
    if (
      event.type === "resync" ||
      (event.type === "stream-connection" && event.connected) ||
      (event.type === "conversation" && event.conversation.id === match[2]) ||
      (event.type === "conversation-turn" && event.conversationId === match[2]) ||
      (event.type === "approval" && event.approval.conversationId === match[2]) ||
      event.type === "approval-resolved"
    ) {
      dirty = true;
      pump();
    }
  });
  if (stopped) {
    unsubscribe();
    return openingAbort;
  }
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  if (!stopped)
    deadline = setTimeout(
      () =>
        fail(
          "The completion stream timed out. Check the conversation before retrying.",
        ),
      options.deadlineMs ?? 15 * 60 * 1000,
    );
  try {
    if (stopped) return await openingAbort;
    const answer = await Promise.race([action(request), openingAbort]);
    if (stopped)
      throw new DOMException("The request was aborted.", "AbortError");
    if (answer.status !== 200) {
      cleanup();
      return new Response(new Uint8Array(answer.body), {
        status: answer.status,
        headers: { "Content-Type": answer.contentType },
      });
    }
    const initial = batch(answer);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          controller = stream;
          emit(initial);
          if (!stopped) {
            dirty = true;
            pump();
          }
        },
        pull() {
          pump();
        },
        cancel() {
          cleanup();
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    cleanup();
    throw error;
  }
}
