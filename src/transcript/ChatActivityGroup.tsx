import { suggestionItem } from "../../shared/chat-suggestions";
import { useRef, useState } from "react";
import { searchesJoin } from "./tools/WebSearchView";
import { ChevronRight } from "../ui/glyphs";
import type { Item, Turn } from "../../shared/types";
import { itemIsRunning, turnActivity } from "../../shared/activity";
import { commandState } from "../code-tools/code-tool-model";
import { thoughtSeconds } from "./CodeTurnStatus";
import { commandDescriptionText } from "../code-tools/tool-description-text";
import { tf } from "../i18n";
import { thoughtLabel } from "./thought-label";
import { toolGroupSummary } from "./tools/tool-group-summary";
import { toolRunningLabel } from "./tools/tool-running-label";
import {
  ActivityElapsed,
  ActivityLabel,
  ActivityMark,
  PreToolActivity,
  turnVerb,
  useLinger,
  useThinkingVerb,
} from "./TurnActivity";
import {
  CommandActivity,
  CommandCard,
  ItemView,
  Markdown,
  type Artifact,
} from "../ui/components";
import {
  TOOL_TYPES,
  isTool,
  thoughtTitle,
  useTimelineArrivals,
} from "./ChatTurnContent";
import type { ChatVariant } from "./ChatTurnContent";

// Preserve chronology: assistant commentary separates activity groups.
export function chatSegments(
  items: Item[],
  skip: Set<string> = new Set(),
  variant: ChatVariant = "chat",
): { id: string; activity: boolean; items: Item[] }[] {
  const result: { id: string; activity: boolean; items: Item[] }[] = [];
  for (const item of items) {
    if (item.type === "diff" || suggestionItem(item)) continue;
    // Chat folds file changes and pictures the agent looked at into the steps
    // group; Cowork keeps them on their own rows.
    const activity =
      ["commandExecution", "reasoning"].includes(item.type) ||
      (variant === "chat" &&
        ["fileChange", "imageView", "imageGeneration", "webSearch"].includes(
          item.type,
        ));
    const last = result.at(-1);
    if (
      (activity && last?.activity) ||
      (item.type === "fileChange" && last?.items[0].type === "fileChange") ||
      // Consecutive web searches share one row.
      (!last?.activity && searchesJoin(last?.items.at(-1), item))
    )
      last!.items.push(item);
    else result.push({ id: item.id, activity, items: [item] });
  }
  // A command run next to connector tool calls folds them into one group. Tool
  // calls that introduce an agent (`skip`) keep their own row. Cowork folds
  // tool calls on their own too.
  const merged: typeof result = [];
  for (const segment of result) {
    const last = merged.at(-1);
    const joinable = (s: (typeof result)[number]) =>
      (s.activity || isTool(s)) && !skip.has(s.items[0].id);
    const mixed = (a: Item[]) =>
      a.some((i) => i.type === "commandExecution") &&
      a.some((i) => TOOL_TYPES.includes(i.type));
    if (
      last &&
      joinable(last) &&
      joinable(segment) &&
      (variant === "cowork" ||
        last.activity ||
        segment.activity ||
        (isTool(last) && isTool(segment)))
    ) {
      const run = [...last.items, ...segment.items];
      if (
        variant === "cowork" ||
        mixed(run) ||
        (last.activity && segment.activity) ||
        // Consecutive connector calls fold too, also across the model's
        // thinking between them.
        run.every(
          (item) => TOOL_TYPES.includes(item.type) || item.type === "reasoning",
        )
      ) {
        merged[merged.length - 1] = { ...last, activity: true, items: run };
        continue;
      }
    }
    merged.push(
      variant === "cowork" && isTool(segment) && !skip.has(segment.id)
        ? { ...segment, activity: true }
        : segment,
    );
  }
  return merged;
}

export function ActivityGroup({
  items,
  turn,
  active,
  awaitingApproval,
  onArtifact,
  variant,
}: {
  items: Item[];
  turn: Turn;
  active: boolean;
  awaitingApproval: boolean;
  onArtifact: (artifact: Artifact) => void;
  variant: ChatVariant;
}) {
  const [disclosureGeneration, setDisclosureGeneration] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useTimelineArrivals(list);
  const phase = active ? turnActivity(turn, awaitingApproval) : "idle";
  const running = !["idle", "streaming"].includes(phase);
  useThinkingVerb(running && phase !== "approval" && phase !== "tools");
  // After the label changes the running marker stays ~0.77s, then goes.
  const marker = useLinger(running, 770);
  const normalized = items.map((item) =>
    turn.status !== "inProgress" && itemIsRunning(item)
      ? { ...item, lifecycleStatus: turn.status }
      : item,
  );
  const commands = normalized.filter(
    (item) => item.type === "commandExecution",
  );
  const tools = normalized.filter((item) => TOOL_TYPES.includes(item.type));
  const rows = normalized.filter(
    (item) =>
      item.type === "commandExecution" ||
      TOOL_TYPES.includes(item.type) ||
      item.summary?.some((text) => text.trim()),
  );
  const grouped = rows.length > 1;
  const failed = commands.some(
    (item) =>
      item.status === "failed" ||
      item.lifecycleStatus === "failed" ||
      (typeof item.exitCode === "number" && item.exitCode !== 0),
  );
  const interrupted =
    (turn.status === "interrupted" && commands.some(itemIsRunning)) ||
    commands.some((item) => item.lifecycleStatus === "interrupted");
  const runningTool = normalized.filter(itemIsRunning).at(-1);
  // Reasoning alone collapses to its duration, as Code's status shows it;
  // without timings it stays generic.
  const thought = thoughtSeconds(items, turn.createdAt, turn.items);
  // The model's description of the running command names the row while it runs;
  // a group of one command keeps it once done, past tense or "Failed to …"
  // (R7). Summaries of several calls stay counts.
  const runningDescription =
    runningTool?.type === "commandExecution"
      ? commandDescriptionText(runningTool, "running")
      : undefined;
  const single =
    commands.length === 1 && !tools.length ? commands[0] : undefined;
  const doneDescription =
    single && commandDescriptionText(single, commandState(single));
  // Cowork's finished row counts the model's notes in the group: "Ran a command
  // · 1 note ›". A note is a reasoning summary; Chat rows carry no count.
  const noteCount =
    variant === "cowork"
      ? items.filter(
          (item) =>
            item.type === "reasoning" &&
            item.summary?.some((text) => text.trim()),
        ).length
      : 0;
  // The group with the turn's last command also names the files the turn handed
  // over: "Ran a command, shared files ›".
  const lastCommand = [...turn.items]
    .reverse()
    .find((item) => item.type === "commandExecution");
  const shared =
    Boolean(lastCommand) &&
    items.some((item) => item.id === lastCommand!.id) &&
    turn.items.some(
      (item) =>
        item.type === "outputFiles" &&
        item.generatedFiles?.some((file) => file.state === "ready"),
    );
  const done = toolGroupSummary(
    shared
      ? [
          ...normalized,
          ...turn.items.filter((item) => item.type === "outputFiles"),
        ]
      : normalized,
    true,
    variant === "cowork",
  );
  const withNotes = (text: string) =>
    noteCount && (commands.length || tools.length)
      ? `${text} · ${tf(noteCount === 1 ? "{n} note" : "{n} notes", { n: noteCount })}`
      : text;
  const label =
    phase === "approval"
      ? "Needs your input"
      : phase === "tools"
        ? runningTool && TOOL_TYPES.includes(runningTool.type)
          ? toolRunningLabel(runningTool)
          : (runningDescription ?? "Running a command")
        : running
          ? thoughtTitle(items, turnVerb(turn))
          : interrupted
            ? "Command stopped"
            : withNotes(
                doneDescription ??
                  (failed && !grouped
                    ? "Command failed"
                    : done
                      ? done.charAt(0).toUpperCase() + done.slice(1)
                      : thought
                        ? thoughtLabel(thought)
                        : "Thought process"),
              );
  const content =
    commands.length ||
    tools.length ||
    items.some((item) => item.summary?.some((text) => text.trim()));
  if (!running && !content) return null;
  const markPhase = phase === "tools" ? "tools" : "thinking";
  const status = (
    <>
      {marker && <ActivityMark phase={markPhase} />}
      <ActivityLabel
        phase={running && phase !== "approval" ? markPhase : undefined}
      >
        {label}
      </ActivityLabel>
      {running && <ActivityElapsed startedAt={turn.createdAt} />}
    </>
  );
  if (!content)
    return (
      <PreToolActivity
        label={label}
        startedAt={turn.createdAt}
        shimmer={phase !== "approval"}
      />
    );
  return (
    <details
      className="command-activity agent-activity-group"
      onToggle={(event) => {
        // Claude resets inner disclosures when reopening the outer activity group.
        if (event.target === event.currentTarget && !event.currentTarget.open)
          setDisclosureGeneration((value) => value + 1);
      }}
    >
      <summary>
        {status}
        <ChevronRight size={12} />
      </summary>
      <div
        ref={variant === "cowork" ? list : undefined}
        className={`agent-activity-content${grouped ? " grouped-activity-card" : ""}${variant === "cowork" ? " cowork-timeline" : ""}`}
        key={disclosureGeneration}
      >
        {rows.map((item) =>
          TOOL_TYPES.includes(item.type) ? (
            <ItemView
              key={item.id}
              item={item}
              mode="chat"
              turnStatus={turn.status}
              startedAt={turn.createdAt}
              needsInput={phase === "approval" && item.id === runningTool?.id}
              onArtifact={onArtifact}
            />
          ) : item.type === "commandExecution" ? (
            grouped ? (
              <CommandActivity
                key={item.id}
                item={item}
                needsInput={phase === "approval" && item.id === runningTool?.id}
              />
            ) : (
              <CommandCard key={item.id} item={item} />
            )
          ) : (
            <div className="activity-summary-text" key={item.id}>
              <Markdown
                text={item.summary?.join("\n\n") ?? ""}
                onArtifact={onArtifact}
              />
            </div>
          ),
        )}
      </div>
    </details>
  );
}
