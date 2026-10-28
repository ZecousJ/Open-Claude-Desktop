import { preference } from "../../shared/settings-extras";
import type { Conversation, Settings, Turn } from "../../shared/types";

/** Where accepting a plan can leave the session besides Accept edits. */
export type PlanTarget = "auto" | "bypass";

/** More accept options. */
export function planAcceptTargets(
  settings: Pick<Settings, "allowBypassPermissions" | "bypassFolders">,
  cwd?: string,
): PlanTarget[] {
  return [
    "auto",
    // Never saved reads as the default (on), as the permission menu does.
    ...(preference(settings, "allowBypassPermissions") === true &&
    cwd &&
    (settings.bypassFolders ?? []).includes(cwd)
      ? (["bypass"] as const)
      : []),
  ];
}

/** Plan mode finished with a plan (Codex `plan` item) and is waiting for a decision. */
export function planAwaitingApproval(
  conversation: Conversation | undefined,
  settings: Settings,
): Turn | undefined {
  if (conversation?.mode !== "code" || !settings.codePlanMode) return;
  const turn = conversation.turns.at(-1);
  if (turn?.status !== "completed") return;
  return turn.items.some(
    (item) => item.type === "plan" && String(item.text ?? "").trim(),
  )
    ? turn
    : undefined;
}
