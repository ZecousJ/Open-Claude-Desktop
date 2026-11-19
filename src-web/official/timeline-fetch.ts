/** Experimental Connect timeline stream reconstructed from account events. */
import type { AppEvent } from "../../shared/types";
import type { OfficialUiReadRequest, OfficialUiReadResponse } from "../../shared/official-ui-web";

type Read = (request: OfficialUiReadRequest) => Promise<OfficialUiReadResponse>;
export type TimelineEvents = (listener: (event: AppEvent) => void) => () => void;

export async function openOfficialTimeline(
  request: OfficialUiReadRequest, signal: AbortSignal, read: Read, subscribe: TimelineEvents,
): Promise<Response> {
  let stopped = false, dirty = false, busy = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let unsubscribe = () => {};
  let rejectOpening!: (reason: unknown) => void;
  const openingCancelled = new Promise<never>((_resolve, reject) => { rejectOpening = reject; });
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    signal.removeEventListener("abort", abort);
  };
  const abort = () => {
    if (stopped) return;
    const error = new DOMException("The request was aborted.", "AbortError");
    if (controller) controller.error(error); else rejectOpening(error);
    cleanup();
  };
  const fail = (error: unknown) => { if (!stopped) { controller?.error(error); cleanup(); } };
  const pump = () => {
    if (stopped || busy || !dirty || !controller || (controller.desiredSize ?? 0) <= 0) return;
    busy = true; dirty = false;
    void read(request).then((answer) => {
      if (stopped) return;
      if (answer.status !== 200 || !/^application\/connect\+proto(?:\s*;|$)/i.test(answer.contentType))
        throw Error("The conversation stream could not be refreshed.");
      controller!.enqueue(new Uint8Array(answer.body));
    }).catch(fail).finally(() => { busy = false; if (dirty) pump(); });
  };
  unsubscribe = subscribe((event) => {
    if (event.type === "signed-out") { abort(); return; }
    if (event.type === "conversation" || event.type === "conversation-turn" || event.type === "approval" || event.type === "approval-resolved" || event.type === "settings" || event.type === "policy" || event.type === "resync" ||
        event.type === "stream-connection" && event.connected) { dirty = true; pump(); }
  });
  if (stopped) { unsubscribe(); return openingCancelled; }
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    if (stopped) return await openingCancelled;
    const initial = await Promise.race([read(request), openingCancelled]);
    if (stopped) throw new DOMException("The request was aborted.", "AbortError");
    if (initial.status !== 200) {
      cleanup();
      return new Response(new Uint8Array(initial.body), { status: initial.status, headers: { "Content-Type": initial.contentType } });
    }
    if (!/^application\/connect\+proto(?:\s*;|$)/i.test(initial.contentType)) {
      cleanup();
      return new Response("Invalid timeline response.", { status: 502 });
    }
    return new Response(new ReadableStream<Uint8Array>({
      start(stream) { controller = stream; stream.enqueue(new Uint8Array(initial.body)); pump(); },
      pull() { pump(); },
      cancel() { cleanup(); },
    }), { status: 200, headers: { "Content-Type": initial.contentType, "Cache-Control": "no-store" } });
  } catch (error) { cleanup(); throw error; }
}
