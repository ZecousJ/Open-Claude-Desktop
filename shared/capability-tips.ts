import type { Conversation, Item, Settings } from "./types";
import type { HostCapabilities } from "./host";
import type { MemoryStatus } from "./memory-api";
import {
  capabilityTips,
  tipAllowed,
  type CapabilityTip,
} from "./chat-suggestions";

export interface TipAvailability {
  cowork: boolean;
  scheduledTasks: boolean;
  projects: boolean;
  skills: boolean;
  memory?: MemoryStatus;
  incognito?: boolean;
  fileUploads?: boolean;
  screenshots?: boolean;
}

export function tipAvailability(
  capabilities: Pick<
    HostCapabilities,
    "localFolders" | "cloudCowork" | "scheduledTasks"
  >,
  hasProjects: boolean,
): TipAvailability {
  return {
    cowork: capabilities.localFolders || capabilities.cloudCowork,
    scheduledTasks: capabilities.scheduledTasks,
    projects: !hasProjects,
    skills: true,
  };
}

// Rn/Bn.
export function eligibleCapabilityTips(
  conversation: Pick<Conversation, "incognito" | "projectId" | "turns"> & {
    id?: string;
  },
  settings: Pick<Settings, "aiArtifacts" | "capabilityTipState">,
  available: TipAvailability,
): CapabilityTip[] {
  if (conversation.incognito) return [];
  const attached = conversation.turns.flatMap((turn) => turn.attachments);
  const searched = conversation.turns.some((turn) =>
    turn.items.some(
      (item) =>
        item.tool === "conversation_search" || item.tool === "recent_chats",
    ),
  );
  return capabilityTips.filter((tip) => {
    const state = settings.capabilityTipState;
    if (
      state &&
      (state.dismissed.includes(tip) ||
        (conversation.id
          ? !tipAllowed(state, tip, conversation.id)
          : (state.ledger[tip]?.count ?? 0) >= 3))
    )
      return false;
    switch (tip) {
      case "cowork":
        return available.cowork;
      case "scheduled_tasks":
        return available.cowork && available.scheduledTasks;
      case "projects":
        return available.projects && !conversation.projectId;
      case "skills":
        return available.skills;
      case "temporary_chat":
        return available.incognito !== false;
      case "memory":
        return (
          !!available.memory?.available &&
          available.memory.allowed.generate &&
          !available.memory.prefs.generate
        );
      case "chat_history_search":
        return (
          !!available.memory?.available &&
          available.memory.allowed.searchChats &&
          available.memory.prefs.searchChats &&
          !searched
        );
      case "file_uploads":
        return available.fileUploads !== false && attached.length === 0;
      case "screenshots":
        return (
          available.screenshots !== false &&
          !attached.some((file) => file.kind === "image")
        );
      default:
        return true;
    }
  });
}

export function capabilityTipKey(value: unknown): CapabilityTip | undefined {
  return typeof value === "string" &&
    capabilityTips.includes(value as CapabilityTip)
    ? (value as CapabilityTip)
    : undefined;
}

export function capabilityTipResult(item: Item | undefined) {
  if (
    !item ||
    item.type !== "dynamicToolCall" ||
    item.tool !== "suggest_capability" ||
    item.status !== "completed" ||
    item.success !== true ||
    !Array.isArray(item.contentItems)
  )
    return;
  try {
    const payload = JSON.parse(
      item.contentItems
        .filter((part: { type?: string }) => part.type === "inputText")
        .map((part: { text?: string }) => part.text ?? "")
        .join("\n"),
    );
    const feature = capabilityTipKey(payload?.feature);
    if (
      payload?.suggest === true &&
      feature &&
      (payload.tier === 1 || payload.tier === 2)
    )
      return { feature, tier: payload.tier as 1 | 2 };
  } catch {}
}

export function inBandCapabilityTip(conversation: Pick<Conversation, "turns">) {
  const turn = conversation.turns.at(-1);
  if (turn?.status !== "completed") return;
  return turn.items.map(capabilityTipResult).find(Boolean)?.feature;
}
