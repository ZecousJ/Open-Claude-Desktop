import type {
  ConversationActionPayloads,
  ConversationActionResult,
  ConversationActionType,
  ConversationEvent,
  ConversationDownloadResult,
} from "../../shared/mobile/conversation-contract";
import { maxConversationDownloadFiles } from "../../shared/mobile/conversation-contract";

/** A native confirmation was declined before any action was dispatched. */
export class ConversationUserDeclinedError extends Error {
  constructor() {
    super("Action cancelled");
    this.name = "ConversationUserDeclinedError";
  }
}

export function downloadResult(
  value: unknown,
  total: number,
): ConversationDownloadResult {
  const result = value as Partial<ConversationDownloadResult> | null;
  if (
    !result ||
    !Number.isSafeInteger(result.saved) ||
    result.saved! < 0 ||
    result.saved! > total ||
    typeof result.cancelled !== "boolean"
  )
    throw Error("Invalid download result");
  return result as ConversationDownloadResult;
}

function validateDownloadBatch(
  payload: ConversationActionPayloads["downloadArtifacts"],
) {
  const { conversationId, files } = payload;
  if (
    typeof conversationId !== "string" ||
    !conversationId ||
    !Array.isArray(files) ||
    files.length < 1 ||
    files.length > maxConversationDownloadFiles ||
    files.some(
      (file) =>
        !file ||
        file.conversationId !== conversationId ||
        typeof file.artifactId !== "string" ||
        !file.artifactId,
    ) ||
    new Set(files.map((file) => file.artifactId)).size !== files.length
  )
    throw Error(
      `Choose between 1 and ${maxConversationDownloadFiles} distinct files from this conversation`,
    );
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  chooser: boolean;
  type: ConversationActionType;
};
/** Native-only transport; no window.desktop, generic method name, fetch, or token. */
export class ConversationBridge {
  private sessionId = "";
  private counter = 0;
  private pending = new Map<string, Pending>();
  constructor(
    private readonly post: (event: ConversationEvent) => void,
    private readonly timeoutMs = 30_000,
    private readonly gestureAuthorized = () => true,
  ) {}
  event(event: ConversationEvent) {
    this.post(event);
  }
  setSession(sessionId: string) {
    if (sessionId === this.sessionId) return;
    this.cancelAll();
    this.sessionId = sessionId;
  }
  request<K extends ConversationActionType>(
    type: K,
    payload: ConversationActionPayloads[K],
  ): Promise<unknown> {
    if (!this.gestureAuthorized())
      return Promise.reject(Error("Tap the control to perform this action"));
    if (!this.sessionId)
      return Promise.reject(Error("Conversation is not ready"));
    if (this.pending.size >= 32)
      return Promise.reject(Error("Too many pending actions"));
    const chooser = type === "downloadArtifact" || type === "downloadArtifacts";
    if (chooser && [...this.pending.values()].some((entry) => entry.chooser))
      return Promise.reject(Error("Finish the current file export first"));
    if (type === "downloadArtifacts") {
      try {
        validateDownloadBatch(
          payload as ConversationActionPayloads["downloadArtifacts"],
        );
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const sessionId = this.sessionId;
    const requestId = `${++this.counter}`;
    return new Promise((resolve, reject) => {
      // A human chooser is lifecycle-scoped, not an RPC. Exactly one bounded
      // export can remain pending; lease rotation/dispose still cancels it.
      const timer = chooser
        ? undefined
        : setTimeout(() => {
            this.pending.delete(requestId);
            this.post({
              version: 1,
              sessionId,
              type: "cancelRequest",
              requestId,
            });
            reject(Error("Action timed out"));
          }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, chooser, type });
      try {
        this.post({
          version: 1,
          sessionId,
          requestId,
          type,
          payload,
        } as ConversationEvent);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : Error(String(error)));
      }
    });
  }
  result(reply: ConversationActionResult) {
    if (!reply || reply.version !== 1 || reply.sessionId !== this.sessionId)
      return false;
    const pending = this.pending.get(reply.requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(reply.requestId);
    if (reply.ok && !reply.cancelled) pending.resolve(reply.result);
    else if (
      reply.ok === false &&
      reply.cancelled === true &&
      reply.cancellationReason === "userDeclined" &&
      (pending.type === "retryResponse" || pending.type === "openLink")
    )
      pending.reject(new ConversationUserDeclinedError());
    else
      pending.reject(
        Error(
          reply.error ||
            (reply.cancelled ? "Action cancelled" : "Action failed"),
        ),
      );
    return true;
  }
  cancelAll() {
    const pendingActions = [...this.pending];
    this.pending.clear();
    for (const [requestId, pending] of pendingActions) {
      clearTimeout(pending.timer);
      try {
        this.post({
          version: 1,
          sessionId: this.sessionId,
          type: "cancelRequest",
          requestId,
        });
      } catch {
        // A closing native view may already have removed the transport. Local
        // promises must still settle and old callbacks must remain invalid.
      }
      pending.reject(Error("Conversation closed"));
    }
  }
  dispose() {
    this.cancelAll();
    this.sessionId = "";
  }
}
