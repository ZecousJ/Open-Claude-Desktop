import { officialMelangeEditPath } from "../../shared/official-melange";
import type {
  OfficialUiReadRequest,
  OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import type { UploadTransfer } from "../../shared/web-client/codec";

type Read = (request: OfficialUiReadRequest) => Promise<OfficialUiReadResponse>;
type Action = (
  request: OfficialUiReadRequest,
  transfer?: UploadTransfer,
) => Promise<OfficialUiReadResponse>;

const streamType = "text/event-stream";

export async function openOfficialMelangeEdit(
  organization: string,
  request: OfficialUiReadRequest,
  signal: AbortSignal,
  read: Read,
  action: Action,
): Promise<Response> {
  signal.throwIfAborted();
  const path = officialMelangeEditPath(organization, crypto.randomUUID());
  const stop = () => {
    void action({ method: "POST", path: path + "/stop" }).catch(() => {});
  };
  let closed = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let rejectStart: (reason: unknown) => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectStart = reject;
  });
  const finish = () => {
    closed = true;
    signal.removeEventListener("abort", abort);
  };
  const abort = () => {
    finish();
    stop();
    if (streamController) streamController.error(signal.reason);
    else rejectStart(signal.reason);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const start = action({ ...request, path }, { signal }).then((answer) => {
      if (closed && answer.status === 202) stop();
      return answer;
    });
    const answer = await Promise.race([start, cancelled]);
    if (
      answer.status !== 202 ||
      answer.contentType !== streamType ||
      answer.body.byteLength
    ) {
      finish();
      if (answer.status >= 400)
        return new Response(new Uint8Array(answer.body), {
          status: answer.status,
          headers: { "Content-Type": answer.contentType },
        });
      stop();
      return Response.json(
        { error: { message: "Memory edit could not be started." } },
        { status: 502 },
      );
    }
  } catch (error) {
    if (!closed) {
      finish();
      stop();
    }
    throw error;
  }

  let cursor = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    async pull(controller) {
      try {
        while (!closed) {
          const answer = await read({
            method: "GET",
            path: path + `?cursor=${cursor}`,
          });
          if (closed) return;
          if (
            answer.contentType !== streamType ||
            !(
              answer.status === 200 ||
              (answer.status === 206 && answer.body.byteLength > 0) ||
              (answer.status === 202 && !answer.body.byteLength)
            )
          )
            throw Error("Invalid memory edit response.");
          if (answer.body.byteLength) {
            cursor += answer.body.byteLength;
            controller.enqueue(answer.body);
          }
          if (answer.status === 200) {
            finish();
            controller.close();
          }
          if (closed || answer.body.byteLength) return;
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      } catch (error) {
        if (closed) return;
        finish();
        stop();
        controller.error(error);
      }
    },
    cancel() {
      finish();
      stop();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": streamType, "Cache-Control": "no-store" },
  });
}
