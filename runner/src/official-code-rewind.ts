import { z } from "zod";
import { rewindHostedCodeHistory } from "../../electron/engine/engine-history";
import {
  codeSteerTranscriptInput,
  convertCodeTranscript,
} from "../../electron/official-ui/native/code-transcript";
import {
  codeTurnCancelledBeforeDispatch,
  officialCodeRewindReply,
} from "../../shared/official-code-followup";
import type { CodeRewindTarget } from "../../shared/code-rewind";
import type { Conversation } from "../../shared/types";
import { officialCodeWorkspaceDirectory } from "./official-code-workspace-files";
import { readCodeQueue } from "./official-code-queue";
import type { WebAppContext } from "./web-app-context";

const messageUuid = z.string().min(1).max(500);
export const hostedCodeRewindControl = z.strictObject({
  subtype: z.literal("rewind_conversation"),
  target_message_uuid: messageUuid,
  last_seen_user_message_uuid: messageUuid.optional(),
});

type RewindResult = z.infer<typeof officialCodeRewindReply>;
const declined = (reason: string): RewindResult => ({
  rewound: false,
  prefillText: "",
  reason,
});

export async function rewindOfficialCodeSession(
  ctx: WebAppContext,
  conversation: Conversation,
  control: z.infer<typeof hostedCodeRewindControl>,
  current: () => boolean,
): Promise<RewindResult> {
  const store = ctx.store;
  const owner = ctx.activeAccount?.id;
  const cwd = officialCodeWorkspaceDirectory(ctx, conversation);
  const idle = () =>
    current() &&
    !ctx.accountRetiring &&
    !conversation.pendingSetup &&
    conversation.worktree?.state !== "deleted" &&
    !conversation.turns.some((turn) => turn.status === "inProgress") &&
    store.hasConfirmedCodeStops(conversation);
  if (!owner || !cwd) return declined("unsupported_session");
  if (
    !idle() ||
    readCodeQueue(store.root, owner, conversation).some(
      (input) =>
        !store.hasConfirmedOfficialCodeEvent(conversation, input.eventId),
    )
  )
    return declined("session_busy");

  const targetUuid = control.target_message_uuid;
  const targets: { boundary: CodeRewindTarget; prefillText: string }[] = [];
  for (const turn of conversation.turns) {
    if (
      turn.compaction ||
      turn.autoContinuation ||
      turn.importedCodeTranscript ||
      codeTurnCancelledBeforeDispatch(turn)
    )
      continue;
    if ((turn.officialCodeEventId ?? `${turn.id}:user`) === targetUuid)
      targets.push({
        boundary: turn.id,
        prefillText: turn.officialCodeDisplayText ?? turn.prompt,
      });
    for (const item of turn.items) {
      const steer = codeSteerTranscriptInput(turn, item);
      if (steer?.uuid === targetUuid)
        targets.push({
          boundary: { turnId: turn.id, itemId: item.id },
          prefillText: steer.text,
        });
    }
  }
  const [target] = targets;
  if (targets.length !== 1) return declined("target_not_found");

  const { rows } = convertCodeTranscript(conversation);
  if (rows.filter((row) => row.uuid === targetUuid).length !== 1)
    return declined("target_not_found");
  const lastSeen = control.last_seen_user_message_uuid;
  const tail = rows
    .reverse()
    .find(
      (row) =>
        !row.parent_tool_use_id &&
        (row.type === "assistant" ||
          (row.type === "user" &&
            !row.origin &&
            !row.uuid.endsWith(":user-interrupt") &&
            (typeof row.message.content === "string" ||
              row.message.content.some(
                (block) => block.type === "text" || block.type === "image",
              )))),
    )?.uuid;
  if (lastSeen !== undefined && lastSeen !== tail)
    return declined("stale_transcript");

  const result = officialCodeRewindReply.safeParse({
    rewound: true,
    prefillText: target.prefillText,
  });
  if (!result.success) return declined("unsupported_prompt");

  try {
    await rewindHostedCodeHistory(
      ctx.engineFor(conversation.id),
      conversation.id,
      target.boundary,
      () => idle() && conversation.cwd === cwd,
      (session, patch, index, active) =>
        store.commitHostedCodeRewind(session, patch, index, active),
    );
    return result.data;
  } catch (error) {
    ctx.log(
      `claudex-runner: Code rewind could not be confirmed: ${String(error)}`,
    );
    return declined("rewind_unconfirmed");
  }
}
