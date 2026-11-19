import { z } from "zod";
import type { AppEvent } from "../../shared/types";
import type {
  OfficialUiReadRequest,
  OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import type { TimelineEvents } from "./timeline-fetch";

type Read = (request: OfficialUiReadRequest) => Promise<OfficialUiReadResponse>;
type Sessions = Map<string, string>;

const listPage = z.object({
  data: z.array(z.looseObject({ id: z.string() })),
  next_cursor: z.string().nullish(),
});
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function readSessions(
  read: Read,
  organization: string | null,
  signal: AbortSignal,
) {
  const sessions: Sessions = new Map();
  const params = new URLSearchParams({ limit: "500" });
  for (;;) {
    signal.throwIfAborted();
    const page = await read({
      method: "GET",
      path: `/v1/code/sessions?${params}`,
      ...(organization !== null ? { codeOrganizationId: organization } : {}),
    });
    if (page.status !== 200) return { kind: "error", page } as const;
    const { data, next_cursor: cursor } = listPage.parse(
      JSON.parse(decoder.decode(page.body)),
    );
    for (const row of data) sessions.set(row.id, JSON.stringify(row));
    if (!cursor) return { kind: "sessions", sessions } as const;
    params.set("cursor", cursor);
  }
}

function codeListChanges() {
  const seen = new Map<string, string>();
  return (event: AppEvent) => {
    switch (event.type) {
      case "resync":
        seen.clear();
        return true;
      case "stream-connection":
        return event.connected;
      case "code-read-state":
      case "remote-code-changed":
      case "devices-changed":
        return true;
      case "conversation": {
        const c = event.conversation;
        if (c.mode !== "code" || c.incognito) return seen.delete(c.id);
        const running = c.turns.some((turn) => turn.status === "inProgress");
        const metadata = JSON.stringify([
          c.title,
          c.archived,
          c.pinned,
          c.unread,
          c.readStateRevision,
          c.model,
          c.effort,
          c.codePermissionMode,
          c.branch,
          c.repository?.url,
          c.environment,
          c.cloudHosted,
          c.sessionAuthors?.ownerAccountUuid,
          c.createdAt,
          running,
          running ? null : c.updatedAt,
        ]);
        if (seen.get(c.id) === metadata) return false;
        seen.set(c.id, metadata);
        return true;
      }
      default:
        return false;
    }
  };
}

export async function openOfficialCodeListWatch(
  request: Request,
  read: Read,
  subscribe: TimelineEvents,
) {
  const organization = request.headers.get("x-organization-uuid");
  const changed = codeListChanges();
  const lifetime = new AbortController();
  let off = () => {};
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelOpening: ((error: DOMException) => void) | undefined;
  let baseline: Sessions;
  let dirty = false;
  let busy = false;

  const stop = () => {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    off();
    request.signal.removeEventListener("abort", abort);
  };
  const abort = () => {
    const error = new DOMException("The request was aborted.", "AbortError");
    if (stream) stream.error(error);
    else cancelOpening?.(error);
    stop();
  };
  const refresh = () => {
    if (
      !stream ||
      !dirty ||
      busy ||
      lifetime.signal.aborted ||
      (stream.desiredSize ?? 0) <= 0
    )
      return;
    dirty = false;
    busy = true;
    void readSessions(read, organization, lifetime.signal)
      .then((result) => {
        if (lifetime.signal.aborted || dirty) return;
        if (result.kind === "error")
          throw Error("The Code session list could not be refreshed.");
        const next = result.sessions;
        let frames = "";
        for (const [id, row] of next) {
          const previous = baseline.get(id);
          if (previous !== row)
            frames += `event: ${previous === undefined ? "added" : "changed"}\ndata: ${row}\n\n`;
        }
        for (const id of baseline.keys()) {
          if (!next.has(id))
            frames += `event: removed\ndata: ${JSON.stringify({ id })}\n\n`;
        }
        baseline = next;
        if (frames) stream?.enqueue(encoder.encode(frames));
      })
      .catch((error: unknown) => {
        if (lifetime.signal.aborted) return;
        stream?.error(error);
        stop();
      })
      .finally(() => {
        busy = false;
        refresh();
      });
  };

  try {
    off = subscribe((event) => {
      if (event.type === "signed-out") abort();
      else if (changed(event)) {
        dirty = true;
        refresh();
      }
    });
    if (lifetime.signal.aborted) {
      off();
      lifetime.signal.throwIfAborted();
    }
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const result = await new Promise<Awaited<ReturnType<typeof readSessions>>>(
      (resolve, reject) => {
        cancelOpening = reject;
        void readSessions(read, organization, lifetime.signal).then(
          resolve,
          reject,
        );
      },
    );
    cancelOpening = undefined;
    lifetime.signal.throwIfAborted();
    if (result.kind === "error") {
      stop();
      const { page } = result;
      return new Response(new Uint8Array(page.body), {
        status: page.status,
        headers: { "Content-Type": page.contentType },
      });
    }
    baseline = result.sessions;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          stream.enqueue(encoder.encode("event: sync\ndata: {}\n\n"));
        },
        pull: refresh,
        cancel: stop,
      }),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    stop();
    throw error;
  }
}
