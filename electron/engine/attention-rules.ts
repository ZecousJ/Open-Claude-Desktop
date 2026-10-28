import type { Approval, Conversation, Schedule } from "../../shared/types";
import {
  approvalItem,
  approvalKind,
  approvalResponse,
  basename,
  commandTitle,
  fileChangeTitle,
  permissionTitle,
} from "../../shared/approval-response";
import { clip, finishedNotice, productName } from "../../shared/notice-text";
import { mcpToolApproval } from "../../shared/mcp-tool-approval";
import { routineCompletionNotices } from "../../shared/routine-notices";

/**
 * A desktop notification, as the system integration shows it. The words and the
 * rules below follow the original's notification service: main-process banners
 * are English there too.
 */
export interface Notice {
  title: string;
  body: string;
  /** A second line under the title (macOS): a Code session's title. */
  subtitle?: string;
  conversationId?: string;
  /**
   * The notice's identity: a later notice with the same tag replaces it, and
   * the integration withdraws it by tag (an answered request, a session the
   * person opened).
   */
  tag?: string;
  /** No sound: a finished turn is a quiet banner in the original. */
  silent?: boolean;
  /**
   * An "Allow once" button that answers this approval with this response.
   * Only for a permission; a question needs its answers.
   */
  allowOnce?: { approvalId: string | number; response: unknown };
  scheduledTasks?: boolean;
}

/** Whether idle sleep should be held off right now (System and Claude Code settings). */
export function wantsKeepAwake(input: {
  keepAwake: boolean;
  keepAwakeWhileCoding: boolean;
  keepAwakeOnBattery: boolean;
  onBattery: boolean;
  codeRunning: boolean;
  /** A Code session's own Keep computer awake is on (any power source). */
  sessionKeepAwake?: boolean;
}) {
  if (input.keepAwake || input.sessionKeepAwake) return true;
  return (
    input.keepAwakeWhileCoding &&
    input.codeRunning &&
    (!input.onBattery || input.keepAwakeOnBattery)
  );
}

const running = (c: Conversation) =>
  c.turns.some((t) => t.status === "inProgress");

export { clip, productName };

/** The notice tags the integration withdraws (see `Notice.tag`). */
export const noticeTags = {
  idle: (conversationId: string) => `idle-${conversationId}`,
  permission: (approvalId: string | number) => `permission-${approvalId}`,
  question: (approvalId: string | number) => `ask-question-${approvalId}`,
  scheduled: (conversationId: string) => `scheduled-${conversationId}`,
};

/**
 * Tracks which conversations are running and returns a notice when one
 * finishes. Incognito chats never produce a notice, and neither does a
 * scheduled task's run: its own "Scheduled task completed" notice says it
 * (the original skips sessions a scheduled task started).
 */
export class TurnWatcher {
  private active = new Set<string>();
  observe(
    c: Conversation,
    options: { scheduledRun?: boolean } = {},
  ): Notice | undefined {
    if (running(c)) {
      this.active.add(c.id);
      return;
    }
    if (!this.active.delete(c.id) || c.incognito || options.scheduledRun)
      return;
    // The original's idle banner: a finished turn (quiet), or one that
    // stopped with an error and waits for the person ("needs input").
    const notice = finishedNotice(c);
    if (!notice) return;
    return {
      title: notice.title,
      body: notice.body,
      conversationId: c.id,
      tag: noticeTags.idle(c.id),
      silent: !notice.failed,
    };
  }
  /** Whether any Code conversation has a turn in progress. */
  codeRunning(conversations: Conversation[]) {
    return conversations.some((c) => c.mode === "code" && running(c));
  }
  reset() {
    this.active.clear();
  }
}

/** The text of the first question a request for input asks, if any. */
function firstQuestion(params: any): string | undefined {
  const questions = params?.questions;
  if (Array.isArray(questions))
    for (const question of questions) {
      const text = question?.question ?? question?.header;
      if (typeof text === "string" && text.trim()) return text;
    }
  return typeof params?.message === "string" ? params.message : undefined;
}

/** What a permission banner asks: "Allow Claudex to run npm test?" and the like. */
function permissionBody(approval: Approval, conversation?: Conversation) {
  const params = approval.params ?? {};
  switch (approvalKind(approval)) {
    case "command":
      return commandTitle(params);
    case "fileChange":
      return fileChangeTitle(
        approvalItem(approval, conversation),
        typeof params.grantRoot === "string" ? params.grantRoot : undefined,
      );
    case "permissions":
      return permissionTitle(params.permissions);
    default: {
      // A connector tool's approval says what the card says.
      const tool = mcpToolApproval(approval);
      if (tool) {
        const name = tool.title ?? "this tool";
        const from = tool.connector ?? tool.server;
        return clip(
          from
            ? `Claudex wants to use ${name} from ${from}`
            : `Claudex wants to use ${name}`,
        );
      }
      // An MCP server's question (the Browser tools among them): its first
      // line, which names the app as the card does.
      const message =
        typeof params.message === "string" ? params.message.split("\n")[0] : "";
      const named = message.replace(/\bClaude\b/g, "Claudex");
      if (named.trim()) return clip(named);
      return typeof params.serverName === "string" && params.serverName
        ? `Allow Claudex to use ${clip(params.serverName, 60)}?`
        : "Claudex needs your approval to use a tool.";
    }
  }
}

/**
 * The banner for a request that waits for the person. Chat says what the
 * original's chat says ("Claude needs your approval"); a question names its
 * session and asks its first question; a Code permission is titled with the
 * session's repository or folder and the session title under it, and a
 * Cowork one with the session's title. Permissions carry an Allow once
 * button where the card has one.
 */
export function approvalNotice(
  approval: Approval,
  conversation: Conversation,
  options: { repoName?: (cwd: string) => string | undefined } = {},
): Notice & { kind: "chat" | "question" | "permission" } {
  const kind = approvalKind(approval);
  const conversationId = conversation.id;
  if (kind === "questions")
    return {
      kind: "question",
      title: clip(conversation.title) || productName(conversation.mode),
      body:
        clip(firstQuestion(approval.params)) ||
        "Claudex is asking you a question",
      conversationId,
      tag: noticeTags.question(approval.id),
    };
  const once =
    kind === "command" || kind === "fileChange" || kind === "permissions"
      ? {
          approvalId: approval.id,
          response: approvalResponse(approval, "once"),
        }
      : undefined;
  if (conversation.mode === "chat")
    return {
      kind: "chat",
      title: "Claudex needs your approval",
      body: "A tool is waiting for your approval",
      conversationId,
      tag: noticeTags.permission(approval.id),
    };
  const body = permissionBody(approval, conversation);
  if (conversation.mode === "cowork")
    return {
      kind: "permission",
      title: clip(conversation.title) || "Cowork",
      body,
      conversationId,
      tag: noticeTags.permission(approval.id),
      ...(once ? { allowOnce: once } : {}),
    };
  const cwd = conversation.cwd;
  const folder = cwd
    ? (options.repoName?.(cwd) ?? basename(cwd)) || undefined
    : undefined;
  const subtitle = clip(conversation.title);
  return {
    kind: "permission",
    title: clip(folder) || productName("code"),
    ...(subtitle ? { subtitle } : {}),
    body,
    conversationId,
    tag: noticeTags.permission(approval.id),
    ...(once ? { allowOnce: once } : {}),
  };
}

export { runningSchedule } from "../../shared/routine-notices";

/**
 * A request in a scheduled task's run: "Scheduled task needs your approval"
 * with the task's name, as the original says it for a run nobody watches.
 */
export function scheduledApprovalNotice(
  task: Schedule,
  approval: Approval,
): Notice {
  return {
    title: "Scheduled task needs your approval",
    body: clip(task.name, 80) || "Scheduled task",
    conversationId: approval.conversationId,
    tag:
      approvalKind(approval) === "questions"
        ? noticeTags.question(approval.id)
        : noticeTags.permission(approval.id),
  };
}

const finished = ["completed", "failed", "interrupted"];

/** More than two attention runs collapse. */
export function groupedScheduleNotices(notices: Notice[]): Notice[] {
  if (notices.length <= 2) return notices;
  return [
    {
      title: `${notices.length} scheduled tasks need your attention`,
      body: "",
      tag: "scheduled-cloud-runs",
      scheduledTasks: true,
    },
  ];
}

/**
 * Scheduled runs that finished or could not run since the previous list:
 * "Scheduled task completed" or "Scheduled task failed", with the task's
 * name as the body (the original's scheduled-run banner).
 */
export function scheduleNotices(
  previous: Schedule[],
  next: Schedule[],
): Notice[] {
  return routineCompletionNotices(previous, next).map(
    ({ taskId, ...notice }) => ({
      ...notice,
      tag: noticeTags.scheduled(notice.conversationId ?? taskId),
    }),
  );
}

/** How long the computer stays awake after the last Code turn ends. */
export const keepAwakeGraceMs = 30_000;
/** A working session that has not moved for this long no longer counts. */
export const keepAwakeStallMs = 60 * 60_000;
/** No turn keeps the computer awake for longer than this. */
export const keepAwakeMaxMs = 24 * 60 * 60_000;

/**
 * The Code turns that keep the computer awake ("Keep computer awake while
 * Claude works"). As in the original, the hold lasts a 30 second grace
 * after the last turn ends (a follow-up turn does not let the computer
 * sleep in between), a turn that has shown no progress for an hour stops
 * counting until it moves again, and none counts for more than a day.
 */
export class CodeWorkTracker {
  private working = new Map<string, { since: number; progressAt: number }>();
  private endedAt?: number;
  observe(c: Conversation, now: number) {
    if (c.mode === "code" && running(c)) {
      const entry = this.working.get(c.id);
      if (entry) entry.progressAt = now;
      else this.working.set(c.id, { since: now, progressAt: now });
      return;
    }
    if (this.working.delete(c.id)) this.endedAt = now;
  }
  /** A conversation that is gone (deleted, or the account changed). */
  forget(conversationId: string) {
    this.working.delete(conversationId);
  }
  private counts(entry: { since: number; progressAt: number }, now: number) {
    return (
      now - entry.progressAt < keepAwakeStallMs &&
      now - entry.since < keepAwakeMaxMs
    );
  }
  /** Whether Code work holds the computer awake now. */
  holding(now: number) {
    for (const entry of this.working.values())
      if (this.counts(entry, now)) return true;
    return this.endedAt !== undefined && now - this.endedAt < keepAwakeGraceMs;
  }
  /** Milliseconds until `holding` can change without a new event, if it can. */
  nextChange(now: number): number | undefined {
    const times: number[] = [];
    for (const entry of this.working.values())
      if (this.counts(entry, now))
        times.push(
          Math.min(
            entry.progressAt + keepAwakeStallMs,
            entry.since + keepAwakeMaxMs,
          ),
        );
    if (this.endedAt !== undefined && now - this.endedAt < keepAwakeGraceMs)
      times.push(this.endedAt + keepAwakeGraceMs);
    if (!times.length) return undefined;
    return Math.max(0, Math.min(...times) - now);
  }
  reset() {
    this.working.clear();
    this.endedAt = undefined;
  }
}
