import { z } from "zod";
import type { SteeredMessageItem } from "./agent-api";
import type { Attachment, CodeEffort, Conversation, Item, Turn } from "./types";
import type { SkillReference } from "./skill-references";

export type OfficialCodeSteer = { eventId: string; inputHash: string };

export type OfficialCodeQueueInput = {
  eventId: string;
  text: string;
  priority: "next" | "later";
  state: "queued" | "held" | "sending" | "unknown";
  createdAt: number;
  attachments: Attachment[];
  choice?: { providerId: string; model: string; effort?: CodeEffort };
  skillReferences?: SkillReference[];
};

export function codeTurnStoppedByUser(turn: Turn) {
  return turn.status === "interrupted" && turn.userStopped === true &&
    !turn.error && turn.stopReason !== "restart";
}

export function codeTurnCancelledBeforeDispatch(turn: Turn) {
  return turn.id.startsWith("pending-") && codeTurnStoppedByUser(turn);
}

export function officialCodeRepositoryStartup(conversation: Conversation) {
  const [turn] = conversation.turns;
  if (
    conversation.mode === "code" &&
    turn?.officialCodeEventId &&
    turn.setup?.repositories &&
    turn.setup.steps.some(step => step.id === "clone" && step.status !== "pending")
  )
    return turn;
}

export function isOfficialCodeSteer(
  item: Item,
): item is SteeredMessageItem & {
  officialCodeEventId: string;
  officialCodeInputHash: string;
} {
  return (
    item.type === "userMessage" &&
    item.steered === true &&
    typeof item.clientId === "string" &&
    typeof item.text === "string" &&
    Array.isArray(item.attachments) &&
    typeof item.officialCodeEventId === "string" &&
    typeof item.officialCodeInputHash === "string"
  );
}

export function officialCodeEvent(turns: readonly Turn[], eventId: string) {
  for (const turn of turns) {
    if (turn.officialCodeEventId === eventId)
      return { kind: "turn" as const, turn };
    for (const steer of turn.items)
      if (isOfficialCodeSteer(steer) && steer.officialCodeEventId === eventId)
        return { kind: "steer" as const, steer };
  }
}

const followupPath =
  /^\/v1\/(code\/)?sessions\/(?:session|cse)_([a-f0-9]{32})\/events$/;

export function officialCodeFollowupPath(method: string, pathname: string) {
  const match = method === "POST" ? followupPath.exec(pathname) : null;
  return match ? { key: match[2], wrapped: !!match[1] } : undefined;
}

const uploadPath =
  /^\/api\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/upload\?store_as_is=true$/i;

export function officialCodeUploadOrganization(method: string, path: string) {
  return method === "POST"
    ? uploadPath.exec(path)?.[1].toLowerCase()
    : undefined;
}

export const officialCodeUploadMaxBytes = 30 * 1024 * 1024 + 64 * 1024;

/** Internal Runner response translated to an unsequenced browser SDK control frame. */
export const officialCodeControlContentType =
  "application/vnd.claudex.code-control+json";

export const officialCodeRewindReply = z.discriminatedUnion("rewound", [
  z.strictObject({ rewound: z.literal(true), prefillText: z.string().max(200_000) }),
  z.strictObject({ rewound: z.literal(false), prefillText: z.literal(""), reason: z.string().max(48) }),
]);

export const officialCodeWorkspaceDiffMaxChars = 8_000_000;
export const officialCodeWorkspaceDiffMaxBytes =
  6 * officialCodeWorkspaceDiffMaxChars + 1_000_000;

const receiptPath =
  /^\/v1\/code\/sessions\/session_([a-f0-9]{32})\/events\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/receipt$/;
export function officialCodeReceiptPath(method: string, path: string) {
  const matched = method === "GET" && receiptPath.exec(path);
  return matched ? { key: matched[1], eventId: matched[2] } : undefined;
}
