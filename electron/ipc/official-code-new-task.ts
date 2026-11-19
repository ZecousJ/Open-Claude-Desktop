import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import type { AppEvent, Conversation } from "../../shared/types";
import { codeCloudSideSessionId, codeCloudSideSessionTarget } from "../../shared/official-code-side-session";
const id = z.string().min(1).max(500);
interface ReleaseContext {
  store: { conversation(id: string): Conversation; flush(): void };
  push?(event: AppEvent): void;
}
/** Private main-process compare-and-release; the native adapter must durably
 * hold this exact input before calling. Never register this as public IPC. */
export function releaseOfficialCodeNewTask(
  ctx: ReleaseContext,
  rawId: unknown,
  rawOffer: unknown,
  rawText: unknown,
) {
  const c = ctx.store.conversation(id.parse(rawId));
  if (
    c.mode !== "code" ||
    c.cloudHosted ||
    (c.environment?.kind ?? "local") !== "local"
  )
    throw Error("A local Code session is required.");
  const offerId = id.parse(rawOffer),
    text = z.string().max(200000).parse(rawText);
  if (c.codeNewTask?.id !== offerId || c.codeNewTask.text !== text)
    return false;
  if (c.codeNewTask.nativeInput) return false;
  if (c.codeNewTask.attachments.length)
    throw Error(
      "Preserve attached legacy input until its attachments can be restored.",
    );
  const offer = c.codeNewTask;
  delete c.codeNewTask;
  try {
    ctx.store.flush();
  } catch (error) {
    c.codeNewTask = offer;
    throw error;
  }
  ctx.push?.({ type: "conversation", conversation: structuredClone(c) });
  return true;
}

const cloudOperation = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("reserve"), target: codeCloudSideSessionTarget }),
  z.strictObject({ kind: z.literal("confirm"), sessionId: codeCloudSideSessionId }),
]);

export function updateOfficialCodeCloudOffer(
  ctx: ReleaseContext,
  rawId: unknown,
  rawTaskId: unknown,
  rawOperation: unknown,
) {
  const c = ctx.store.conversation(id.parse(rawId));
  const taskId = id.parse(rawTaskId);
  const operation = cloudOperation.parse(rawOperation);
  const offer = c.codeNewTask;
  if (c.mode !== "code" || c.archived || c.incognito || c.cloudHosted ||
      (c.environment?.kind ?? "local") !== "local" ||
      !offer?.nativeInput || offer.id !== taskId) return false;
  const previousLinks = c.cloudSpawnedTasks;
  if (operation.kind === "reserve") {
    if (offer.cloudTarget) return isDeepStrictEqual(offer.cloudTarget, operation.target);
    c.codeNewTask = { ...offer, cloudTarget: operation.target };
  } else {
    if (!offer.cloudTarget) return false;
    delete c.codeNewTask;
    c.cloudSpawnedTasks = [...(previousLinks ?? []), {
      taskId, sessionId: operation.sessionId, title: offer.text.slice(0, 100),
      messageUuid: offer.nativeInput.uuid,
    }];
  }
  try {
    ctx.store.flush();
  } catch (error) {
    c.codeNewTask = offer;
    c.cloudSpawnedTasks = previousLinks;
    throw error;
  }
  ctx.push?.({ type: "conversation", conversation: structuredClone(c) });
  return true;
}
