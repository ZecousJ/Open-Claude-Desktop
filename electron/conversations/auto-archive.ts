import type { Conversation, Settings } from "../../shared/types";
import { preference } from "../../shared/settings-extras";
import { codeSessionLifecyclePending } from "./code-lifecycle-guard";

const DAY = 86_400_000;
const awaitingInputMs = DAY;
export const autoArchiveCheckMs = 5 * 60_000;
const maxChecksPerSweep = 20;

const activity = (c: Conversation) => Math.max(
  c.updatedAt ?? c.createdAt ?? Infinity,
  c.codeLastFocusedAt ?? 0,
);

function desktopCode(c: Conversation) {
  return c.mode === "code" && !c.archived && !c.incognito && !c.pinned &&
    !c.cloudHosted && !c.cloudEnvironmentId && c.environment?.kind !== "space";
}

function isDesktopArchiveCandidate(c: Conversation, held: (id: string) => boolean, ownsLifecycle = false) {
  return desktopCode(c) &&
    !c.codeAutoArchiveExempt && !c.codeNewTask && (ownsLifecycle || !codeSessionLifecyclePending(c)) &&
    !c.officialCodeQueuedTurns?.some(turn => turn.queueState !== "cancelled") &&
    !held(c.id) &&
    !c.turns.some(turn => turn.status === "inProgress" || turn.items.some(item =>
      "status" in item && (item.status === "inProgress" || item.status === "running")));
}

export function inactiveSessions(
  conversations: readonly Conversation[],
  settings: Settings,
  now: number,
  held: (id: string) => boolean = () => false,
  ownsLifecycle = false,
): string[] {
  const days = preference(settings, "autoArchiveDays");
  if (!days) return [];
  return conversations.filter(c =>
    (c.environment?.kind ?? "local") === "local" &&
    isDesktopArchiveCandidate(c, held, ownsLifecycle) &&
    now - activity(c) >= days * DAY)
    .map(c => c.id);
}

type ArchiveReason = "inactive" | "merged" | "closed";
type PullDecision = "merged" | "closed" | undefined;

export function startAutoArchive(deps: {
  settings: () => Settings;
  conversations: () => readonly Conversation[];
  held: (id: string) => boolean;
  pull: (c: Conversation) => Promise<PullDecision>;
  archive: (id: string, reason: ArchiveReason, eligible: (ownsLifecycle?: boolean) => boolean) => Promise<unknown>;
  now?: () => number;
}): { check(): Promise<void>; stop(): void } {
  let stopped = false;
  let sweep: Promise<void> | undefined;
  const now = deps.now ?? Date.now;
  const current = (c: Conversation, ownsLifecycle = false) => !stopped &&
    deps.conversations().includes(c) && isDesktopArchiveCandidate(c, deps.held, ownsLifecycle);
  const on = (c: Conversation) =>
    c.prAutoArchive ?? preference(deps.settings(), "prAutoArchive");
  let nextPullCheck = 0;
  const eligible = (c: Conversation, reason: ArchiveReason, ownsLifecycle = false) => {
    if (!current(c, ownsLifecycle)) return false;
    if (reason === "inactive") {
      return inactiveSessions([c], deps.settings(), now(), deps.held, ownsLifecycle).length === 1;
    }
    const awaitingInput = c.sessionState === "blocked" || c.turns.at(-1)?.status === "failed";
    return on(c) && (!awaitingInput || now() - activity(c) >= awaitingInputMs);
  };
  const run = async () => {
    const sessions = deps.conversations();
    let checks = 0;
    const start = sessions.length ? nextPullCheck % sessions.length : 0;
    for (let offset = 0; offset < sessions.length; offset++) {
      const index = (start + offset) % sessions.length;
      const c = sessions[index];
      if (stopped) return;
      try {
        if (eligible(c, "inactive")) {
          await deps.archive(c.id, "inactive", owns => eligible(c, "inactive", owns));
        } else if (checks < maxChecksPerSweep && desktopCode(c) && (on(c) || deps.held(c.id))) {
          checks++;
          nextPullCheck = index + 1;
          const since = activity(c);
          const decision = await deps.pull(c);
          if (!decision || !eligible(c, decision)) continue;
          const stillEligible = (owns?: boolean) => eligible(c, decision, owns) && activity(c) === since;
          if (stillEligible()) await deps.archive(c.id, decision, stillEligible);
        }
      } catch {
        // A later sweep re-reads the session and PR before applying a change.
      }
    }
  };
  const check = () => sweep ??= run().finally(() => { sweep = undefined; });
  const startup = setTimeout(() => void check(), 30_000);
  const timer = setInterval(() => void check(), autoArchiveCheckMs);
  startup.unref?.();
  timer.unref?.();
  return {
    check,
    stop: () => {
      stopped = true;
      clearTimeout(startup);
      clearInterval(timer);
    },
  };
}
