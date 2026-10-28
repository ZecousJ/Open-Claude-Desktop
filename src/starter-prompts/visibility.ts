import type { Mode } from "../../shared/types";

// O16 shared-23:7227–7246, shared-3:10844–10852. Context exclusion
// wraps the whole starter/checklist surface, before staff/count overrides.
export function homeStarterContextAllowed({
  targetKind = "chat",
  channelProjectSelected = false,
  foldersUserTouched = false,
  folderSelected = false,
  folderScopeValid = false,
}: {
  targetKind?: Mode;
  channelProjectSelected?: boolean;
  foldersUserTouched?: boolean;
  folderSelected?: boolean;
  folderScopeValid?: boolean;
} = {}) {
  return (
    targetKind === "chat" &&
    !channelProjectSelected &&
    !(foldersUserTouched && folderSelected && folderScopeValid)
  );
}

// The current shaped Chat branch skips the old generic/finance surface. Returns
// before those chips for homeShaped + Chat; n2 passes the shape at 8081-8094.
// Classic homes retain the later count/override/checklist gates below.
export function legacyHomeStartersAllowed(
  homeShaped = false,
  targetKind: Mode = "chat",
) {
  return !(homeShaped && targetKind === "chat");
}

// Incognito and an active voice surface hide the starters before anything
// else is considered.
export function starterPromptsVisible({
  incognito = false,
  voiceActive = false,
  conversationCount = 0,
  override,
  hideStarterChips = false,
  conversationLoading = false,
  checklistLoading = false,
  checklistShowing = false,
  hideForChecklist = false,
}: {
  incognito?: boolean;
  voiceActive?: boolean;
  conversationCount?: number;
  override?: "show" | "hide";
  hideStarterChips?: boolean;
  conversationLoading?: boolean;
  checklistLoading?: boolean;
  checklistShowing?: boolean;
  hideForChecklist?: boolean;
}) {
  if (incognito || voiceActive || hideStarterChips) return false;
  if (override === "hide") return false;
  if (
    (checklistLoading && !checklistShowing) ||
    (checklistShowing && hideForChecklist)
  )
    return false;
  return (
    override === "show" || (!conversationLoading && conversationCount < 25)
  );
}
