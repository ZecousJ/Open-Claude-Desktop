import {
  officialCodeCommand,
  officialCodeSequence,
  officialCodeStreamSuggestion,
  officialCodeStreamTool,
  officialCodeTaskUpdate,
  type OfficialCodeCommand,
  type OfficialCodeStreamRequest,
  type OfficialCodeStreamSuggestion,
  type OfficialCodeStreamTool,
} from "../../shared/official-code-history";
import {
  officialCodeApprovalControl,
  type OfficialCodeApprovalControl,
} from "../../shared/official-code-approval";
import {
  codeApiRetryClearedMessage,
  officialCodeApiRetryMessage,
  type CodeApiRetryMessage,
} from "../../shared/official-code-retry";
import {
  officialUiTransferMaxBytes,
  type OfficialUiReadRequest,
  type OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import type { TimelineEvents } from "./timeline-fetch";
import { interruptTargetSchema } from "../../shared/interrupt-target";

type Read = (request: OfficialUiReadRequest) => Promise<OfficialUiReadResponse>;
export type CodeControlReply = { requestId: string } & (
  | { response: Record<string, unknown>; persisted?: true; error?: never }
  | { error: string; response?: never; persisted?: never }
);
type Batch = {
  conversation_id: string;
  cowork?: true;
  session: {
    id: string;
    worker_status: "running" | "idle";
    environment_kind?: string;
    claudex_stop_target?: { target: unknown } | null;
    config?: { model?: string };
  };
  data: {
    sequence_num: number;
    event_id: string;
    processing_at?: string;
    payload: { type: string; uuid?: string };
  }[];
  has_more: boolean;
  processedQueue?: { event_id: string; timestamp: string }[];
  partial?: { id: string; text: string; kind?: "thinking" };
  tools?: OfficialCodeStreamTool[];
  controls?: OfficialCodeApprovalControl[];
  commands?: OfficialCodeCommand[];
  compacting?: string;
  api_retry?: CodeApiRetryMessage | null;
  prompt_suggestion?: OfficialCodeStreamSuggestion | null;
  task_updates?: { uuid: string }[];
};

const cursorId = /^evt_[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const frameApprovals = new WeakMap<EventTarget, Map<string, Set<string>>>();
const aborted = () =>
  new DOMException("The Code stream was closed.", "AbortError");

function readBatch(
  answer: OfficialUiReadResponse,
  key: string,
  from: number,
): Batch {
  if (
    !/^application\/json(?:\s*;|$)/i.test(answer.contentType) ||
    answer.body.byteLength > officialUiTransferMaxBytes
  )
    throw Error("Invalid Code stream batch.");
  const batch = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(answer.body),
  );
  if (
    !batch ||
    typeof batch.conversation_id !== "string" ||
    !batch.conversation_id ||
    (batch.cowork !== undefined && batch.cowork !== true) ||
    batch.session?.id !== "session_" + key ||
    !["running", "idle"].includes(batch.session.worker_status) ||
    !Array.isArray(batch.data) ||
    batch.data.length > 100 ||
    typeof batch.has_more !== "boolean" ||
    (batch.has_more && !batch.data.length) ||
    (batch.processedQueue !== undefined && (!Array.isArray(batch.processedQueue) || batch.processedQueue.length > 256 ||
      batch.processedQueue.some((entry: { event_id: string; timestamp: string }) =>
        !cursorId.test(entry?.event_id) || typeof entry?.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp))))) ||
    batch.data.some(
      (event: Batch["data"][number], index: number) =>
        event?.sequence_num !== from + index + 1 ||
        !cursorId.test(event.event_id) ||
        typeof event.payload?.type !== "string",
    ) ||
    (batch.controls !== undefined &&
      !officialCodeApprovalControl.array().safeParse(batch.controls).success) ||
    (batch.tools !== undefined &&
      !officialCodeStreamTool.array().safeParse(batch.tools).success) ||
    (batch.commands !== undefined && !officialCodeCommand.array().max(200).safeParse(batch.commands).success) ||
    (batch.compacting !== undefined && typeof batch.compacting !== "string") ||
    (batch.api_retry != null &&
      (!officialCodeApiRetryMessage.safeParse(batch.api_retry).success ||
        batch.api_retry.session_id !== batch.session.id)) ||
    (batch.prompt_suggestion != null &&
      !officialCodeStreamSuggestion.safeParse(batch.prompt_suggestion).success) ||
    (batch.task_updates !== undefined && !officialCodeTaskUpdate.array().max(128).safeParse(batch.task_updates).success) ||
    (batch.partial !== undefined &&
      (!batch.partial ||
        typeof batch.partial.id !== "string" ||
        typeof batch.partial.text !== "string" ||
        (batch.partial.kind !== undefined && batch.partial.kind !== "thinking")))
  )
    throw Error("Invalid Code stream batch.");
  return batch;
}

const eventFrame = (type: string, value: unknown, id?: number) =>
  (id === undefined ? "" : `id: ${id}\n`) +
  `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;

/** The Runner replies with finite owned snapshots. Only the frame holds an SSE connection. */
export async function openOfficialCodeStream(
  request: Request,
  url: URL,
  query: OfficialCodeStreamRequest,
  read: Read,
  subscribe: TimelineEvents,
  controls?: EventTarget,
) {
  const resume = request.headers.get("last-event-id");
  const [position, anchor, extra] = resume?.split(":", 3) ?? [];
  const from = position === undefined ? query.from : officialCodeSequence(position);
  if (
    query.afterEventId ||
    from === undefined ||
    extra !== undefined ||
    (anchor !== undefined && (from === 0 || !cursorId.test(anchor)))
  )
    return Response.json(
      { error: "Invalid Code stream cursor." },
      { status: 400 },
    );
  let sequence = from;
  let lastEventId: string | undefined = anchor;
  let ownerConversation: string | undefined;
  let remote = false;
  let worker: string | undefined;
  let commands: string | undefined;
  let compacting: string | undefined;
  let retry: CodeApiRetryMessage | null | undefined;
  let suggestion: OfficialCodeStreamSuggestion | null | undefined;
  const taskUpdates = new Map<string, string>();
  let preview:
    | { id: string; text: string; kind: "text" | "thinking"; tools: OfficialCodeStreamTool[] }
    | undefined;
  let openApprovals = new Set<string>();
  let frameSessions = controls && frameApprovals.get(controls);
  if (controls && !frameSessions) {
    frameSessions = new Map();
    frameApprovals.set(controls, frameSessions);
  }
  let reconnectApprovals = frameSessions?.get(query.key);
  let coworkControlsPublished = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const pendingControls: CodeControlReply[] = [];
  const deliverControls = () => {
    if (
      stopped ||
      !controller ||
      (controller.desiredSize ?? 0) <= 0 ||
      !pendingControls.length
    )
      return;
    const chunk = pendingControls
      .splice(0)
      .map(({ requestId, response, error }) =>
        eventFrame("client_event", {
          source: "worker",
          payload: {
            type: "control_response",
            response: error === undefined
              ? { subtype: "success", request_id: requestId, response }
              : { subtype: "error", request_id: requestId, error },
          },
        }),
      )
      .join("");
    controller.enqueue(encoder.encode(chunk));
  };
  const receiveControl = (event: Event) => {
    if (stopped || !controller || pendingControls.length >= 16) return;
    event.preventDefault();
    pendingControls.push((event as CustomEvent<CodeControlReply>).detail);
    deliverControls();
  };
  let stopped = false,
    dirty = false,
    busy = false;
  let off = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let remoteUpdates: ReturnType<typeof setInterval> | undefined;
  let cancelOpening!: (error: unknown) => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancelOpening = reject;
  });
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    clearInterval(remoteUpdates);
    controls?.removeEventListener(query.key, receiveControl);
    request.signal.removeEventListener("abort", abort);
    off();
  };
  const fail = (error: unknown) => {
    if (stopped) return;
    if (controller) controller.error(error);
    else cancelOpening(error);
    cleanup();
  };
  const abort = () => fail(aborted());
  const load = () => {
    const search = new URLSearchParams({ from_sequence_num: String(sequence) });
    if (lastEventId) search.set("after_event_id", lastEventId);
    const org = request.headers.get("x-organization-uuid");
    return read({
      method: "GET",
      path: url.pathname + "?" + search,
      ...(org !== null ? { codeOrganizationId: org } : {}),
    });
  };
  const loadCurrent = async () => {
    const answer = await load();
    if (answer.status !== 410 || sequence === 0) return { answer, reset: false };
    sequence = 0;
    lastEventId = undefined;
    return { answer: await load(), reset: true };
  };
  const deliveredQueue = new Set<string>();
  const resetTranscript = () => {
    worker = undefined;
    commands = undefined;
    compacting = undefined;
    retry = undefined;
    suggestion = undefined;
    preview = undefined;
    taskUpdates.clear();
    deliveredQueue.clear();
    openApprovals = new Set();
    reconnectApprovals = undefined;
    coworkControlsPublished = false;
    frameSessions?.delete(query.key);
    controller!.enqueue(encoder.encode(eventFrame("catch_up_truncated", { claudex_transcript_reset: true }, 0)));
  };
  const publish = (batch: Batch) => {
    if (ownerConversation && ownerConversation !== batch.conversation_id)
      throw Error("The Code session changed.");
    ownerConversation = batch.conversation_id;
    remote = batch.session.environment_kind === "bridge";
    let chunk = "";
    for (const entry of batch.processedQueue ?? []) {
      if (deliveredQueue.has(entry.event_id)) continue;
      deliveredQueue.add(entry.event_id);
      chunk += eventFrame("delivery_update", { event_id: entry.event_id, status: "processed", timestamp: entry.timestamp });
    }
    const workerFrame = (payload: Record<string, unknown>) => eventFrame("client_event", {
      source: "worker", payload: { session_id: batch.session.id, ...payload },
    });
    const workerChanged = worker !== batch.session.worker_status;
    if (workerChanged) {
      const opening = worker === undefined;
      worker = batch.session.worker_status;
      chunk += eventFrame("session_update", {
        ...batch.session,
        connection_status: "connected",
      });
      if (opening)
        chunk += eventFrame("client_event", {
          source: "worker",
          payload: {
            type: "system",
            subtype: "status",
            status: null,
            session_id: batch.session.id,
            uuid: crypto.randomUUID(),
          },
        });
    }

    // Model frames stay outside the replay cursor until the transcript can commit.
    const ephemeral = (event: Record<string, unknown>) =>
      eventFrame("ephemeral_event", {
        event_type: "stream_event",
        payload: {
          type: "stream_event",
          session_id: batch.session.id,
          parent_tool_use_id: null,
          event,
        },
      });
    const startPreview = (id: string) => ephemeral({
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: batch.session.config?.model,
        content: [],
      },
    });
    const tools = batch.tools ?? [];
    const stop = remote && worker === "running"
      ? interruptTargetSchema.safeParse(batch.session.claudex_stop_target?.target) : undefined;
    const activeMessage = stop?.success ? `${stop.data.turnId}:waiting` : undefined;
    const id = tools.length ? `${tools[0].id}:use` : batch.partial?.id ?? activeMessage;
    const next =
      batch.has_more || id === undefined
        ? undefined
        : { id, text: batch.partial?.text ?? "", kind: batch.partial?.kind ?? "text", tools } as const;
    if (
      preview &&
      (preview.id !== next?.id ||
        preview.kind !== next.kind ||
        !next.text.startsWith(preview.text) ||
        (!preview.text && next.text && preview.tools.length > 0) ||
        !preview.tools.every((tool, index) => {
          const candidate = next.tools[index];
          return (
            candidate?.id === tool.id &&
            candidate.name === tool.name &&
            candidate.inputJson === tool.inputJson
          );
        }))
    ) {
      if (preview.text)
        chunk += ephemeral({ type: "content_block_stop", index: 0 });
      chunk += ephemeral({ type: "message_stop" });
      if (!next && !batch.has_more && worker === "running" &&
          (preview.kind === "thinking" || (preview.text && batch.api_retry)) &&
          !batch.data.some(({ payload }) => payload.uuid === preview?.id)) {
        chunk += startPreview(preview.id);
        chunk += ephemeral({ type: "message_stop" });
      }
      preview = undefined;
    }
    for (const event of batch.data) {
      // The original browser transport keeps client input queued until its
      // separate delivery notification, even when the envelope has this date.
      if (
        event.payload.type === "user" &&
        typeof event.processing_at === "string"
      ) {
        deliveredQueue.add(event.event_id);
        chunk += eventFrame("delivery_update", {
          event_id: event.event_id,
          status: "processed",
          timestamp: event.processing_at,
        });
      }
      chunk += eventFrame("client_event", event, event.sequence_num);
      sequence = event.sequence_num;
      lastEventId = event.event_id;
    }
    if (remote && workerChanged && worker === "idle")
      chunk += workerFrame({ type: "system", subtype: "status", status: null, uuid: crypto.randomUUID() });
    if (next) {
      if (!preview) chunk += startPreview(next.id);
      if (!preview && next.id === activeMessage)
        chunk += workerFrame({ type: "system", subtype: "status", status: "requesting", uuid: crypto.randomUUID() });
      if (next.text && !preview?.text) {
        chunk += ephemeral({
          type: "content_block_start",
          index: 0,
          content_block: next.kind === "thinking"
            ? { type: "thinking", thinking: "" }
            : { type: "text", text: "" },
        });
      }
      const text = next.text.slice(preview?.text.length ?? 0);
      if (text)
        chunk += ephemeral({
          type: "content_block_delta",
          index: 0,
          delta: next.kind === "thinking"
            ? { type: "thinking_delta", thinking: text }
            : { type: "text_delta", text },
        });
      for (let i = preview?.tools.length ?? 0; i < next.tools.length; i++) {
        const tool = next.tools[i];
        const index = i + (next.text ? 1 : 0);
        chunk += ephemeral({
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: tool.id,
            name: tool.name,
            input: {},
          },
        });
        chunk += ephemeral({
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: tool.inputJson },
        });
        chunk += ephemeral({ type: "content_block_stop", index });
      }
      preview = next;
    }
    if (!batch.has_more) {
      const nextSuggestion = batch.prompt_suggestion;
      if (nextSuggestion !== undefined && (
        suggestion === undefined || suggestion?.resultUuid !== nextSuggestion?.resultUuid ||
        suggestion?.text !== nextSuggestion?.text
      )) {
        chunk += workerFrame({ type: "prompt_suggestion", suggestion: nextSuggestion?.text ?? "" });
        suggestion = nextSuggestion;
      }
      if (batch.commands) {
        const next = JSON.stringify(batch.commands);
        if (next !== commands) {
          chunk += workerFrame({ type: "system", uuid: crypto.randomUUID(), ...(commands === undefined
            ? { subtype: "init", slash_commands: batch.commands, model: batch.session.config?.model }
            : { subtype: "commands_changed", commands: batch.commands }) });
          commands = next;
        }
      }
      if (batch.compacting !== compacting) {
        compacting = batch.compacting;
        chunk += workerFrame({ type: "system", subtype: "status", uuid: crypto.randomUUID(), status: compacting ? "compacting" : null });
      }
      for (const update of batch.task_updates ?? []) {
        const value = JSON.stringify(update);
        if (taskUpdates.get(update.uuid) === value) continue;
        taskUpdates.set(update.uuid, value);
        chunk += workerFrame({ ...update, uuid: crypto.randomUUID() });
      }
      const pending = batch.controls ?? [];
      const ids = new Set(pending.map((control) => control.request_id));
      if (batch.cowork) {
        if (!coworkControlsPublished || ids.size !== openApprovals.size ||
            [...ids].some((id) => !openApprovals.has(id)))
          chunk += eventFrame("client_event", {
            source: "worker",
            payload: { type: "claudex_cowork_approvals", controls: pending },
          });
        coworkControlsPublished = true;
      } else {
        const controlFrame = (payload: unknown) =>
          eventFrame("client_event", { source: "worker", payload });
        for (const request_id of reconnectApprovals ?? openApprovals) {
          if (!ids.has(request_id))
            chunk += controlFrame({ type: "control_cancel_request", request_id });
        }
        for (const control of pending) {
          if (!openApprovals.has(control.request_id))
            chunk += controlFrame(control);
        }
      }
      reconnectApprovals = undefined;
      openApprovals = ids;
      if (ids.size) frameSessions?.set(query.key, ids);
      else frameSessions?.delete(query.key);
      const nextRetry = batch.api_retry;
      if (nextRetry !== undefined && (
        (nextRetry && chunk) || retry === undefined || retry?.uuid !== nextRetry?.uuid ||
        retry?.error !== nextRetry?.error || retry?.max_retries !== nextRetry?.max_retries
      )) {
        chunk += workerFrame(nextRetry ?? codeApiRetryClearedMessage(batch.session.id));
        retry = nextRetry;
      }
    }
    if (chunk) controller!.enqueue(encoder.encode(chunk));
    dirty ||= batch.has_more;
  };
  const pump = () => {
    if (
      stopped ||
      busy ||
      !dirty ||
      !controller ||
      (controller.desiredSize ?? 0) <= 0
    )
      return;
    busy = true;
    dirty = false;
    void loadCurrent()
      .then(({ answer, reset }) => {
        if (stopped) return;
        if (answer.status !== 200)
          throw Error("The Code stream could not be refreshed.");
        if (reset) resetTranscript();
        publish(readBatch(answer, query.key, sequence));
      })
      .catch(fail)
      .finally(() => {
        busy = false;
        if (dirty) pump();
      });
  };

  try {
    const initialRead = Promise.race([
      Promise.resolve().then(() => {
        if (stopped) return cancelled;
        return resume !== null ? loadCurrent() : load().then(answer => ({ answer, reset: false }));
      }),
      cancelled,
    ]);
    off = subscribe((event) => {
      if (event.type === "signed-out") {
        abort();
        return;
      }
      if (event.type === "stream-connection" && !event.connected && !remote) {
        fail(Error("The Runner event connection closed."));
        return;
      }
      if (
        event.type === "resync" ||
        event.type === "devices-changed" ||
        (event.type === "remote-code-changed" && remote &&
          (!event.conversationId || event.conversationId === ownerConversation)) ||
        (event.type === "device-event" && remote) ||
        event.type === "stream-connection" ||
        event.type === "settings" ||
        (event.type === "conversation" &&
          (!ownerConversation ||
            event.conversation.id === ownerConversation)) ||
        (event.type === "conversation-turn" &&
          (!ownerConversation || event.conversationId === ownerConversation)) ||
        (event.type === "approval" &&
          (!ownerConversation ||
            event.approval.conversationId === ownerConversation)) ||
        (event.type === "approval-resolved" &&
          (!ownerConversation || busy || openApprovals.size > 0))
      ) {
        dirty = true;
        pump();
      }
    });
    if (stopped) off();
    else request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const { answer, reset } = await initialRead;
    if (stopped) throw aborted();
    if (answer.status !== 200) {
      cleanup();
      return new Response(new Uint8Array(answer.body), {
        status: answer.status,
        headers: {
          "Content-Type": answer.contentType,
          "Cache-Control": "no-store",
        },
      });
    }
    const initial = readBatch(answer, query.key, sequence);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          controller = stream;
          controls?.addEventListener(query.key, receiveControl);
          if (reset) resetTranscript();
          publish(initial);
          if (remote)
            remoteUpdates = setInterval(() => {
              dirty = true;
              pump();
            }, 3000);
          heartbeat = setInterval(() => {
            if (!stopped && (controller!.desiredSize ?? 0) > 0)
              controller!.enqueue(encoder.encode(": heartbeat\n\n"));
          }, 12_000);
          pump();
        },
        pull() {
          deliverControls();
          pump();
        },
        cancel: cleanup,
      }),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    cleanup();
    throw error;
  }
}
