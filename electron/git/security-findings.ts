import fs from "node:fs";
import path from "node:path";
import type { RoutineRun } from "../../shared/routine-labels";
import {
  applyScan,
  applyTriage,
  dismissalLabels,
  emptyFindings,
  findingLimit,
  findingStatuses,
  reportFromMessages,
  scanLimit,
  severities,
  sortFindings,
  type FindingTriage,
  type SecurityFinding,
  type SecurityFindingsState,
  type SecurityFindingsView,
  type SecurityScan,
} from "../../shared/security-review";

export const securityFindingsName = "security-findings.json";

interface Sources {
  /** A routine's runs, newest first. */
  runs: (routineId: string) => RoutineRun[];
  /** The text of the assistant's messages in the run's turn, or undefined when its conversation is gone. */
  messages: (conversationId: string) => string[] | undefined;
  /** The routines that exist; the findings of any other are dropped. */
  routines: () => Iterable<string>;
}

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const optionalString = (value: unknown) =>
  value === undefined || typeof value === "string";
const optionalNumber = (value: unknown) =>
  value === undefined || isNumber(value);

/** A finding from disk with its shape checked; false when it cannot be used. */
function validFinding(value: unknown): value is SecurityFinding {
  const f = value as Partial<Record<keyof SecurityFinding, unknown>> | null;
  return (
    !!f &&
    typeof f === "object" &&
    typeof f.id === "string" &&
    typeof f.title === "string" &&
    severities.includes(f.severity as never) &&
    findingStatuses.includes(f.status as never) &&
    typeof f.description === "string" &&
    typeof f.evidence === "string" &&
    typeof f.impact === "string" &&
    typeof f.recommendation === "string" &&
    Array.isArray(f.steps) &&
    f.steps.every((step) => typeof step === "string") &&
    isNumber(f.firstSeenAt) &&
    isNumber(f.lastSeenAt) &&
    optionalString(f.file) &&
    optionalString(f.cwe) &&
    optionalString(f.category) &&
    optionalString(f.branch) &&
    optionalString(f.commit) &&
    optionalString(f.dismissalNote) &&
    optionalNumber(f.start) &&
    optionalNumber(f.end) &&
    optionalNumber(f.fixedAt) &&
    optionalNumber(f.triagedAt) &&
    (f.fixedBy === undefined || f.fixedBy === "scan" || f.fixedBy === "you") &&
    (f.dismissalReason === undefined ||
      (typeof f.dismissalReason === "string" &&
        f.dismissalReason in dismissalLabels))
  );
}

function validScan(value: unknown): value is SecurityScan {
  const s = value as Partial<Record<keyof SecurityScan, unknown>> | null;
  return (
    !!s &&
    typeof s === "object" &&
    typeof s.runId === "string" &&
    isNumber(s.at) &&
    typeof s.readable === "boolean" &&
    isNumber(s.found) &&
    isNumber(s.added) &&
    isNumber(s.fixed) &&
    optionalString(s.branch) &&
    optionalString(s.commit)
  );
}

function validState(value: unknown): SecurityFindingsState {
  const state = value as Partial<SecurityFindingsState> | null;
  if (!state || typeof state !== "object") return emptyFindings();
  return {
    scans: (Array.isArray(state.scans) ? state.scans : [])
      .filter(validScan)
      .slice(0, scanLimit),
    ingested: (Array.isArray(state.ingested) ? state.ingested : []).filter(
      (id): id is string => typeof id === "string",
    ),
    findings: (Array.isArray(state.findings) ? state.findings : [])
      .filter(validFinding)
      .slice(0, findingLimit),
  };
}

/**
 * The findings of the security-review routines, one file per account. A
 * routine's runs are read when its list is asked for: each completed run's
 * answer is read as a report once (shared/security-review.ts) and merged, so
 * the list needs nothing running in the background and a run's findings arrive
 * the next time the list is opened.
 */
export class SecurityFindingsStore {
  private readonly filename: string;
  constructor(
    root: string,
    private readonly sources: Sources,
  ) {
    this.filename = path.join(root, securityFindingsName);
  }
  private read(): Record<string, SecurityFindingsState> {
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(this.filename, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(
        "Your security findings couldn't be read. The file has not been overwritten.",
      );
    }
    const routines = (data as { routines?: unknown } | null)?.routines;
    if (!routines || typeof routines !== "object" || Array.isArray(routines))
      throw new Error(
        "Your security findings couldn't be read. The file has not been overwritten.",
      );
    return Object.fromEntries(
      Object.entries(routines).map(([id, state]) => [id, validState(state)]),
    );
  }
  private write(routines: Record<string, SecurityFindingsState>) {
    const temporary = `${this.filename}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ routines }, null, 2), {
      mode: 0o600,
    });
    fs.renameSync(temporary, this.filename);
  }
  /** Reads the runs not yet merged; true when the state changed. */
  private ingest(routineId: string, state: SecurityFindingsState) {
    const seen = new Set(state.ingested);
    const fresh = this.sources
      .runs(routineId)
      .filter((run) => run.status === "completed" && !seen.has(run.id))
      .sort((a, b) => a.startedAt - b.startedAt);
    let next = state;
    for (const run of fresh) {
      const texts = run.conversationId
        ? this.sources.messages(run.conversationId)
        : undefined;
      next = applyScan(next, {
        runId: run.id,
        at: run.finishedAt ?? run.startedAt,
        report: texts ? reportFromMessages(texts) : undefined,
      });
    }
    return next;
  }
  private view(state: SecurityFindingsState): SecurityFindingsView {
    return {
      findings: sortFindings(state.findings),
      scans: state.scans.slice(),
    };
  }
  /** Merges the new runs and returns the routine's list. */
  list(routineId: string): SecurityFindingsView {
    const known = new Set(this.sources.routines());
    const all = this.read();
    let changed = false;
    for (const id of Object.keys(all))
      if (!known.has(id)) {
        delete all[id];
        changed = true;
      }
    if (!known.has(routineId))
      throw new Error("This scheduled task no longer exists.");
    const before = all[routineId] ?? emptyFindings();
    const after = this.ingest(routineId, before);
    if (after !== before || changed || !all[routineId]) {
      all[routineId] = after;
      this.write(all);
    }
    return this.view(after);
  }
  triage(
    routineId: string,
    findingId: string,
    triage: FindingTriage,
  ): SecurityFindingsView {
    // New runs are merged first, so a triage never lands on an older list.
    this.list(routineId);
    const all = this.read();
    const next = applyTriage(
      all[routineId] ?? emptyFindings(),
      findingId,
      triage,
      Date.now(),
    );
    all[routineId] = next;
    this.write(all);
    return this.view(next);
  }
}

/** The text of the assistant's messages in the first turn of a conversation's turns. */
export function runMessages(
  turns: { items: { type: string; text?: unknown }[] }[],
): string[] {
  const turn = turns[0];
  if (!turn) return [];
  return turn.items
    .filter((item) => item.type === "agentMessage")
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .filter(Boolean);
}
