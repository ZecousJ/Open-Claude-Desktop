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

// The current shaped Chat branch skips the old generic/finance surface.
// Official shared-23-nKYgvBe8.js:7653-7684 returns before those chips
// for homeShaped + Chat; n2 passes the shape at 8081-8094. Classic
// homes retain the later count/override/checklist gates below.
export function legacyHomeStartersAllowed(
  homeShaped = false,
  targetKind: Mode = "chat",
) {
  return !(homeShaped && targetKind === "chat");
}

// Live claude.ai bundle, 2026-10-14, shared-23-RHw-hr47.js:
// incognito and an active voice surface take priority over the staff override.
export function starterPromptsVisible({
  incognito = false,
  voiceActive = false,
  conversationCount = 0,
  accountEmail,
  force = false,
  override,
  hideStarterChips = false,
  conversationLoading = false,
  checklistLoading = false,
  checklistShowing = false,
  hideForChecklist = false,
  skillsLoading = false,
  skillSurface = false,
}: {
  incognito?: boolean;
  voiceActive?: boolean;
  conversationCount?: number;
  accountEmail?: string;
  force?: boolean;
  override?: "show" | "hide";
  hideStarterChips?: boolean;
  conversationLoading?: boolean;
  checklistLoading?: boolean;
  checklistShowing?: boolean;
  hideForChecklist?: boolean;
  skillsLoading?: boolean;
  skillSurface?: boolean;
}) {
  if (incognito || voiceActive || hideStarterChips) return false;
  const staff = /@(anthropic\.com|sillylittleguy\.org)$/.test(
    accountEmail ?? "",
  );
  if (force && staff) return true;
  if (override === "hide") return false;
  if (
    skillsLoading ||
    (checklistLoading && !checklistShowing) ||
    (checklistShowing && hideForChecklist)
  )
    return false;
  return (
    !skillSurface &&
    (override === "show" || (!conversationLoading && conversationCount < 25))
  );
}

export function starterPromptsForced() {
  try {
    return localStorage.getItem("cai_drifting_cupcake:dev-force") === "true";
  } catch {
    return false;
  }
}
