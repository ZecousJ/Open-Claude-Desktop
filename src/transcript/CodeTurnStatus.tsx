import { useTranscriptSlots } from "./transcript-slots";
import { Fragment, useEffect, useState } from "react";
import type { Item, Turn } from "../../shared/types";
import { itemIsRunning, turnActivity } from "../../shared/activity";
import { formatElapsed, formatTokens } from "../code-tools/code-tool-model";
import { KnotShape } from "../ui/Star";
import { TextMorph } from "../ui/TextMorph";
import { clearStopping, useTurnStopping } from "./turn-stopping";
import { useStreamConnection } from "../app/connection";
import { thoughtLabel } from "./thought-label";
import { formatText, t, tc } from "../i18n";
import { retryCauseHeadlines } from "../../shared/turn-errors";
import { prefersReducedMotion } from "../ui/usePresence";
import { ClayMark } from "./clay-mark/ClayMark";
import { markBody } from "./clay-mark/activity";
import { runningTool, runningVerb } from "./status-verb";
import { useSmoothedCount } from "./smoothed-count";

/* Code transcript pieces measured on claude-code-terminal-lifecycle-own-001.mov,
   claude-code-terminal-expanded-own-001.png and the R-0806-0807 recording (2x). */

/*
 * R-0806 frames 23–49 (2.0 px/CSS): one 0.81s cycle of eight sizes, 4.5 → 9 →
 * 13 → 17 → 13 → 9 → 6.5 → 4.5 CSS px. The largest frame holds ~167ms, the
 * others ~92ms. Small frames are dots; the others are the Claudex knot.
 */
const SPINNER_SIZES = [4.5, 9, 13, 17, 13, 9, 6.5, 4.5] as const;
const SPINNER_HOLD = [92, 92, 92, 167, 92, 92, 92, 91] as const;
const LARGEST = 3;

function starShape(size: number) {
  if (size < 8) return <circle cx="10" cy="10" r={size / 2} />;
  return <KnotShape cx={10} cy={10} size={size} stroke={1.3} inheritColor />;
}

export function CodeSpinner() {
  const [step, setStep] = useState<number>(LARGEST);
  useEffect(() => {
    // The in-app Motion setting counts as well as the system's.
    if (prefersReducedMotion()) return;
    let index = 0;
    let timer = 0;
    const tick = () => {
      setStep(index);
      timer = window.setTimeout(() => {
        index = (index + 1) % SPINNER_SIZES.length;
        tick();
      }, SPINNER_HOLD[index]);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <svg
      className="code-spinner"
      data-step={step}
      viewBox="0 0 20 20"
      width="20"
      height="20"
      aria-hidden="true"
    >
      {starShape(SPINNER_SIZES[step])}
    </svg>
  );
}

/** The spinner's largest frame, left still when a Code reply ends. */
export function CodeEndStar() {
  return (
    <svg
      className="code-spinner code-end-star"
      viewBox="0 0 20 20"
      width="20"
      height="20"
      aria-hidden="true"
    >
      {starShape(SPINNER_SIZES[LARGEST])}
    </svg>
  );
}

/**
 * Seconds of model reasoning, from local item observation times. A reasoning
 * item that streams no summary (GPT models through Codex) is observed only once
 * the model has finished thinking, so its own start and end are the same moment
 * and read "Thought for 0s". Such a span (under a second) therefore starts
 * where the model went quiet: at the end of the item before it in `context`
 * (the whole turn when given), else at `origin` (the turn's start), else at its
 * own start.
 */
export function thoughtSeconds(
  items: Item[],
  origin?: number,
  context: Item[] = items,
) {
  const spans = items.filter(
    (item) =>
      item.type === "reasoning" &&
      typeof item.startedAt === "number" &&
      typeof item.completedAt === "number",
  );
  if (!spans.length) return undefined;
  const total = spans.reduce((sum, item) => {
    const start = item.startedAt as number;
    const own = (item.completedAt as number) - start;
    // Reasoning watched as it streamed keeps its own span.
    if (own >= 1000) return sum + own;
    // The latest end before this item started, among the items before it.
    let quiet: number | undefined;
    for (const other of context) {
      if (other === item) break;
      const end = other.completedAt ?? other.startedAt;
      if (typeof end === "number" && end <= start && (quiet ?? -1) < end)
        quiet = end;
    }
    quiet ??= typeof origin === "number" && origin <= start ? origin : start;
    return sum + Math.max(0, (item.completedAt as number) - quiet);
  }, 0);
  return Math.round(total / 1000);
}

// "Thought for Ns" stayed visible for about three seconds after reasoning ended (70.0–73.0s).
const THOUGHT_NOTICE_MS = 3000;
/*
 * The thinking label moves on as the turn runs: "Still thinking…" from 15s,
 * "Thinking more…" from 30s, "Thinking some more…" from 45s and "Almost done
 * thinking…" from a minute.
 */
export const STILL_THINKING_SECONDS = 15;
export const THINKING_MORE_SECONDS = 30;
export const THINKING_SOME_MORE_SECONDS = 45;
export const ALMOST_DONE_SECONDS = 60;

export function thinkingLabel(seconds: number) {
  return seconds >= ALMOST_DONE_SECONDS
    ? "Almost done thinking…"
    : seconds >= THINKING_SOME_MORE_SECONDS
      ? "Thinking some more…"
      : seconds >= THINKING_MORE_SECONDS
        ? "Thinking more…"
        : seconds >= STILL_THINKING_SECONDS
          ? "Still thinking…"
          : "Thinking…";
}

/**
 * What the window knows of the turn beyond its items: a Stop that has not
 * ended it yet, and the window's event stream being down. Of the original's
 * Connecting / Sending / Starting session / Preparing phases only Starting
 * session has an engine counterpart (a cloud session's setup, Turn.setup),
 * read from the turn itself.
 */
export interface CodeStatusPhase {
  stopping?: boolean;
  connecting?: boolean;
}

export interface CodeStatus {
  /** The running tool's word, leading the line before its own timer. */
  leading?: string;
  /** Timer, tokens and running tasks: shown steady. */
  meta: string[];
  /** The verb phrase; it breathes unless it reports finished reasoning. */
  label?: string;
  pulse: boolean;
}

/** What ended among the session's background tasks, by how. */
export type SettledTasks = {
  completed?: number;
  failed?: number;
  stopped?: number;
};

/**
 * The task segment: "{count} background {noun} {status}" for the first of
 * completed, failed, stopped and running that has any, then "{count} failed"
 * and the others after commas; nothing when there are none. A plain number is
 * completed.
 */
export function taskSummary(running: number, finished: number | SettledTasks) {
  return taskSummaryParts(running, finished)
    ?.map((part) => part.text)
    .join(", ");
}

/** taskSummary's parts, each marked when it counts failed tasks. */
export function taskSummaryParts(
  running: number,
  finished: number | SettledTasks,
) {
  const settled =
    typeof finished === "number" ? { completed: finished } : finished;
  const counts: [string, number][] = [
    ["completed", settled.completed ?? 0],
    ["failed", settled.failed ?? 0],
    ["stopped", settled.stopped ?? 0],
    ["running", running],
  ];
  const parts = counts.filter(([, count]) => count > 0);
  if (!parts.length) return undefined;
  const [[status, count], ...rest] = parts;
  return [
    {
      text: formatText(
        count === 1
          ? "{count} background task {status}"
          : "{count} background tasks {status}",
        { count, status: formatText(status) },
      ),
      failed: status === "failed",
    },
    ...rest.map(([key, n]) => ({
      text: formatText(`{count} ${key}`, { count: n }),
      failed: key === "failed",
    })),
  ];
}

/**
 * Tokens of what is still being written. The model reports its usage when a
 * response ends, so while it writes a file or a long reply the count would
 * stand still; until the report comes the line counts the text streamed so far,
 * about four characters a token for Latin text and one and a half for other
 * scripts, as the live desktop's count also moves while a file is written.
 */
export function streamingTokens(items: Item[]) {
  let latin = 0;
  let other = 0;
  const count = (text: unknown) => {
    if (typeof text !== "string") return;
    for (const char of text)
      if (char.charCodeAt(0) < 128) latin++;
      else other++;
  };
  for (const item of items) {
    if (!itemIsRunning(item)) continue;
    if (item.type === "fileChange")
      for (const change of item.changes ?? []) count(change.diff);
    else if (item.type === "agentMessage") count(item.text);
    else if (item.type === "reasoning")
      for (const part of item.summary ?? []) count(part);
  }
  return Math.ceil(latin / 4 + other / 1.5);
}

/** The steady parts of the line, each kept apart so it can appear on its own. */
export function codeStatusMeta(
  turn: Turn,
  now: number,
  runningTasks = 0,
  finishedTasks: number | SettledTasks = 0,
) {
  // A running tool's own time stands in for the turn's.
  const tool = runningTool(turn.items);
  const since =
    tool && typeof tool.startedAt === "number"
      ? tool.startedAt
      : turn.createdAt;
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const tokens = (turn.outputTokens ?? 0) + streamingTokens(turn.items);
  // The elapsed counter first appeared at 2s ("2s · Waiting for Claude…");
  // longer turns read "4m 53s" and "36m 49s", tokens "4.0k tokens".
  return {
    elapsed: seconds >= 2 ? formatElapsed(seconds) : undefined,
    tokens: tokens > 0 ? formatTokens(tokens) : undefined,
    tasks: taskSummary(runningTasks, finishedTasks),
  };
}

export function codeStatus(
  turn: Turn,
  now: number,
  awaitingApproval = false,
  runningTasks = 0,
  { stopping = false, connecting = false }: CodeStatusPhase = {},
  finishedTasks: number | SettledTasks = 0,
): CodeStatus {
  const phase = turnActivity(turn, awaitingApproval);
  // Pending input keeps its label and background task segment.
  if (phase === "approval" && !stopping) {
    const tasks = taskSummary(runningTasks, finishedTasks);
    return {
      meta: tasks ? [tasks] : [],
      label: "Needs your input",
      pulse: false,
    };
  }
  const seconds = Math.max(0, Math.floor((now - turn.createdAt) / 1000));
  const reasoningEnded = Math.max(
    0,
    ...turn.items
      .filter(
        (item) =>
          item.type === "reasoning" && typeof item.completedAt === "number",
      )
      .map((item) => item.completedAt as number),
  );
  const thinking = turn.items.some(
    (item) => item.type === "reasoning" && itemIsRunning(item),
  );
  const thought = thoughtSeconds(turn.items, turn.createdAt);
  // Under a second of reasoning is no notice ("Thought for 0s").
  const thoughtNotice =
    !stopping &&
    !connecting &&
    phase !== "waiting" &&
    !thinking &&
    thought != null &&
    thought >= 1 &&
    now - reasoningEnded < THOUGHT_NOTICE_MS;
  // While the reply text streams the line carries only the timer and the token
  // count; "Thinking…" belongs to the 5s frame before any text. A cloud
  // session's start (Turn.setup) is the original's "starting" phase; Claudex
  // says it is waiting for Claudex instead.
  const starting = turn.setup?.steps.some(
    (step) => step.status === "running" || step.status === "pending",
  );
  // A dropped stream Codex retries, and a /compact turn, read as the original's
  // status line does. The headline names the cause when it is known (sign-in,
  // rate limit, busy server), else the lost connection.
  const retry = turn.reconnecting?.match(/^(\d+)\/(\d+)$/);
  // The headline is the failure's own; a plain dropped stream is the
  // connection.
  const cause = turn.reconnectCause
    ? t(retryCauseHeadlines[turn.reconnectCause])
    : undefined;
  const label = stopping
    ? "Stopping…"
    : turn.reconnecting
      ? cause
        ? retry
          ? formatText("{cause} · Retrying ({attempt}/{maxRetries})", {
              cause,
              attempt: retry[1],
              maxRetries: retry[2],
            })
          : formatText("{cause} · Retrying…", { cause })
        : retry
          ? formatText("Connection lost · Retrying ({attempt}/{maxRetries})", {
              attempt: retry[1],
              maxRetries: retry[2],
            })
          : "Connection lost · Retrying…"
      : turn.compaction
        ? "Compacting session…"
        : turn.worktreeStep
          ? "Creating worktree…"
          : connecting
            ? "Connecting…"
            : starting && !turn.items.length
              ? "Waiting for Claudex…"
              : phase === "waiting"
                ? "Waiting for Claudex…"
                : thoughtNotice
                  ? thoughtLabel(thought)
                  : phase === "streaming" || phase === "tools"
                    ? undefined
                    : // A plain "Thinking" after the timer, without the
                      // older line's "Still thinking…" steps.
                      "Thinking";
  const tool = phase === "tools" ? runningTool(turn.items) : undefined;
  const leading =
    !stopping && !turn.reconnecting && tool ? runningVerb(tool) : undefined;
  const parts = codeStatusMeta(turn, now, runningTasks, finishedTasks);
  const meta = [parts.elapsed, parts.tokens, parts.tasks].filter(
    (part): part is string => Boolean(part),
  );
  return { leading, meta, label, pulse: !thoughtNotice };
}

export function codeStatusParts(
  turn: Turn,
  now: number,
  awaitingApproval = false,
  runningTasks = 0,
  finishedTasks: number | SettledTasks = 0,
): string[] {
  const status = codeStatus(
    turn,
    now,
    awaitingApproval,
    runningTasks,
    undefined,
    finishedTasks,
  );
  const parts = status.label ? [...status.meta, status.label] : status.meta;
  return status.leading ? [status.leading, ...parts] : parts;
}

export function CodeTurnStatus({
  turn,
  latest = true,
  awaitingApproval,
  runningTasks = 0,
  backgroundTasks = 0,
  finishedTasks = 0,
  backgroundOpen = false,
  onOpenBackground,
}: {
  turn: Turn;
  /** Only the newest reply keeps the still star under it. */
  latest?: boolean;
  awaitingApproval: boolean;
  /** Background terminals, agents and workflows running now (not foreground commands). */
  runningTasks?: number;
  /** Background terminals still running after the turn ended. */
  backgroundTasks?: number;
  /** Background tasks that ended and have not been cleared from the panel, by how. */
  finishedTasks?: number | SettledTasks;
  /** Whether the Background tasks panel is open (the task button's pressed state). */
  backgroundOpen?: boolean;
  /** Opens the Background tasks panel, or closes it when it is open. */
  onOpenBackground?: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  const active = turn.status === "inProgress";
  const stopping = useTurnStopping(turn.id);
  const slots = useTranscriptSlots();
  const { connected } = useStreamConnection();
  useEffect(() => {
    if (!active) clearStopping(turn.id);
  }, [active, turn.id]);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [active, turn.createdAt]);
  // The token count climbs to each new figure rather than jumping.
  const tokenCount = useSmoothedCount(
    active ? (turn.outputTokens ?? 0) + streamingTokens(turn.items) : 0,
    turn.id,
  );
  if (!active) {
    if (!latest || turn.compaction) return null;
    const label = taskSummary(
      backgroundTasks,
      onOpenBackground ? finishedTasks : 0,
    );
    // A finished reply ends bare: the still mark after it is gone from the live
    // desktop. Only a blue "1 running task" badge stays; tasks that only
    // finished get the same badge.
    if (!label) return null;
    // Tasks that only settled read as a plain line, secondary until hovered,
    // with a failed count in red; only running tasks get the blue badge.
    if (!backgroundTasks) {
      const parts = taskSummaryParts(0, finishedTasks) ?? [];
      return (
        <div className="code-turn-status code-turn-settled" role="status">
          <button
            type="button"
            className="code-settled-tasks"
            onClick={onOpenBackground}
            aria-pressed={backgroundOpen}
            aria-label={formatText("{label}, open background tasks", { label })}
          >
            {parts.map((part, index) => (
              <Fragment key={part.text}>
                {index > 0 && ", "}
                <span className={part.failed ? "is-failed" : undefined}>
                  {part.text}
                </span>
              </Fragment>
            ))}
          </button>
        </div>
      );
    }
    return (
      <div className="code-turn-status code-turn-end" role="status">
        <button
          type="button"
          className="code-running-badge"
          onClick={onOpenBackground}
          aria-pressed={backgroundOpen}
          aria-label={formatText("{label}, open background tasks", { label })}
        >
          {label}
        </button>
      </div>
    );
  }
  const finished = onOpenBackground ? finishedTasks : 0;
  const computed = codeStatus(
    turn,
    now,
    awaitingApproval,
    runningTasks,
    { stopping, connecting: !connected },
    finished,
  );
  // A surface with its own words (the phone's "Working…") keeps the older
  // line's label for a running tool instead of the tool's word.
  const ownTools = computed.leading
    ? slots.CodeStatusLabels?.["Running tools…"]
    : undefined;
  const reworded = ownTools
    ? ownTools
    : computed.label && slots.CodeStatusLabels?.[computed.label];
  const status = reworded
    ? {
        ...computed,
        label: reworded,
        leading: ownTools ? undefined : computed.leading,
      }
    : computed;
  const parts = [
    ...(status.leading ? [status.leading] : []),
    ...status.meta,
    ...(status.label ? [status.label] : []),
  ];
  // The approval row keeps only its spinner and its task segment.
  const all = codeStatusMeta(turn, now, runningTasks, finished);
  const meta: Partial<typeof all> =
    turnActivity(turn, awaitingApproval) === "approval" && !stopping
      ? { tasks: all.tasks }
      : {
          ...all,
          tokens:
            all.tokens && tokenCount > 0
              ? formatTokens(tokenCount)
              : all.tokens,
        };
  return (
    <div
      className="code-turn-status"
      role="status"
      aria-label={parts.join(" · ") || "Working…"}
    >
      <ClayMark body={markBody(turn, awaitingApproval && !stopping)} />
      <span className="code-status-text">
        <span className="code-status-part" aria-hidden="true">
          <TextMorph morphKey={status.leading ?? null}>
            <span className="code-status-leading">{status.leading}</span>
          </TextMorph>
          <TextMorph morphKey={meta.elapsed ? "elapsed" : null}>
            {meta.elapsed}
          </TextMorph>
          <TextMorph morphKey={meta.tokens ? "tokens" : null}>
            <StatusDot shown={Boolean(meta.elapsed)} />
            {meta.tokens}
          </TextMorph>
        </span>
        <TextMorph morphKey={meta.tasks ? "tasks" : null}>
          <span className="code-status-part" aria-hidden="true">
            <StatusDot shown={Boolean(meta.elapsed || meta.tokens)} />
          </span>
          {onOpenBackground ? (
            // The task segment opens and closes the Background tasks panel
            // (a ghost button in the original).
            <button
              type="button"
              className="code-status-tasks"
              aria-pressed={backgroundOpen}
              onClick={onOpenBackground}
            >
              {meta.tasks}
            </button>
          ) : (
            <span aria-hidden="true">{meta.tasks}</span>
          )}
        </TextMorph>
        <span className="code-status-part" aria-hidden="true">
          <TextMorph morphKey={status.label ? "status" : null}>
            <StatusDot shown={status.meta.length > 0} />
            <TextMorph morphKey={status.label ?? null}>
              <span
                className="code-status-label"
                data-pulse={status.pulse || undefined}
              >
                {/* The line's "Thinking" is the ongoing state (思考中), not
                    the transcript menu's noun (思考). */}
                {status.label === "Thinking"
                  ? tc("status", "Thinking")
                  : status.label}
              </span>
            </TextMorph>
          </TextMorph>
        </span>
      </span>
    </div>
  );
}

/** The "·" between parts, which opens and closes with the part after it. */
function StatusDot({ shown }: { shown: boolean }) {
  return (
    <TextMorph morphKey={shown ? "dot" : null}>
      <span className="code-status-sep">·</span>
    </TextMorph>
  );
}
