import {
  Suspense,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { ChevronRight } from "../ui/glyphs";
import type { Item, Turn } from "../../shared/types";
import { itemIsRunning, turnActivity } from "../../shared/activity";
import { ClayMark } from "../ui/ClayMark";
import {
  ActivityElapsed,
  ActivityLabel,
  turnVerb,
  useThinkingVerb,
  useLinger,
} from "./TurnActivity";
import { Collapsible } from "../ui/Collapsible";
import { ChevronDownIcon } from "../ui/icons";
import { thoughtTitle } from "./ChatTurnContent";
import { thoughtSeconds } from "./CodeTurnStatus";
import { failed } from "../code-tools/code-tool-model";
import { AppContext } from "../app/AppContext";
import { ResultRows, isSearchItem, searchSources } from "./tools/WebSearchView";
import { FileChangeCards } from "./tools/FileChangeView";
import { t, tf, useT } from "../i18n";
import { isWebFetch } from "../../shared/web-fetch-item";
import { WebFetchRow } from "./tools/WebFetchRow";
import { type Artifact } from "../ui/components";
import {
  GeneratedImageCard,
  isChatStep,
  chatStepsSummary,
  STEP_MOTION_MS,
  MARK_DEPART_MS,
  STEP_WINDOW,
  useLeavingRows,
  ChatStep,
  STEPS_HEADER,
  StepSlot,
} from "./ChatSteps";
import { stepLine } from "./chat-step-lines";

/** The card's rows: the header (when some steps are hidden), then the steps. */
function StepsList({
  steps,
  hidden,
  allSteps,
  onAllSteps,
  live,
  pendingItemId,
  turn,
  onArtifact,
}: {
  steps: Item[];
  /** How many earlier steps the window hides; 0 for none. */
  hidden: number;
  allSteps: boolean;
  onAllSteps: () => void;
  live: boolean;
  pendingItemId?: string;
  turn: Turn;
  onArtifact: (artifact: Artifact) => void;
}) {
  // Rows present when the card opens are part of its opening.
  const shown = useRef(false);
  useEffect(() => {
    shown.current = true;
  }, []);
  const rows = useLeavingRows<{ id: string }>(
    [...(hidden ? [{ id: STEPS_HEADER }] : []), ...steps],
    STEP_MOTION_MS,
  );
  return (
    <div className="chat-steps-list">
      {rows.map(({ item, leaving }) => (
        <StepSlot key={item.id} leaving={leaving} arriving={shown.current}>
          {item.id === STEPS_HEADER ? (
            <button
              type="button"
              className="chat-steps-more"
              aria-expanded={allSteps}
              onClick={onAllSteps}
            >
              <ChevronDownIcon size={12} aria-hidden="true" />
              {allSteps
                ? t("Hide steps")
                : hidden === 1
                  ? t("1 step")
                  : tf("{n} steps", { n: hidden })}
            </button>
          ) : (
            <ChatStep
              item={item as Item}
              live={live}
              needsInput={item.id === pendingItemId}
              turn={turn}
              onArtifact={onArtifact}
            />
          )}
        </StepSlot>
      ))}
    </div>
  );
}

/**
 * Chat's steps group. While the reply works: the working dots, the latest
 * thought (or the running step), the elapsed time and ⌄, over an open card that
 * lists each step on one line — a command by its description, a file change as
 * "Created file.html", a thought by its summary — the running one shimmering.
 * Once a running group has three steps the card shows the latest two under "{n}
 * steps", which shows the rest (and then reads "Hide steps"); a new step opens
 * in at the bottom while the oldest folds away above it. When the reply is done
 * the dots stay a moment and fade (420ms), the row slides back to the text's
 * edge and, once they are gone, reads what the steps did ("Read a file, created
 * a file ›"), closed. The card opens and closes to its height. Pages the steps
 * wrote follow as artifact cards.
 */
export function ChatStepsGroup({
  items,
  turn,
  active,
  awaitingApproval,
  onArtifact,
}: {
  items: Item[];
  turn: Turn;
  active: boolean;
  awaitingApproval: boolean;
  onArtifact: (artifact: Artifact) => void;
}) {
  const app = useContext(AppContext);
  useT();
  const phase = active ? turnActivity(turn, awaitingApproval) : "idle";
  const running = !["idle", "streaming"].includes(phase);
  useThinkingVerb(running && phase !== "approval");
  // The dots linger while they depart; the new label waits for them.
  const departing = useLinger(running, MARK_DEPART_MS) && !running;
  const [userOpen, setUserOpen] = useState<boolean>();
  const [allSteps, setAllSteps] = useState(false);
  const cardId = useId();
  const normalized = items.map((item) =>
    turn.status !== "inProgress" && itemIsRunning(item)
      ? { ...item, lifecycleStatus: turn.status }
      : item,
  );
  const steps = normalized.filter(isChatStep);
  const changes = normalized.filter((item) => item.type === "fileChange");
  const made = normalized.filter(
    (item) =>
      item.type === "imageGeneration" &&
      item.status !== "failed" &&
      typeof item.savedPath === "string" &&
      item.savedPath,
  );
  const thoughts = normalized.filter(
    (item) =>
      item.type === "reasoning" && item.summary?.some((text) => text.trim()),
  );
  const current = normalized.filter(itemIsRunning).at(-1);
  // The group with the turn's last command also names the files the turn handed
  // over: "Ran a command, shared files".
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
  const label =
    phase === "approval"
      ? t("Needs your input")
      : running
        ? thoughts.length
          ? thoughtTitle([thoughts.at(-1)!], turnVerb(turn))
          : current && isChatStep(current)
            ? stepLine(current).text
            : turnVerb(turn)
        : chatStepsSummary(
            shared
              ? [
                  ...normalized,
                  ...turn.items.filter((item) => item.type === "outputFiles"),
                ]
              : normalized,
            false,
          );
  // The outcome after a settled group's row, as the original's turn status
  // words it: its last step failed ("Failed", danger ink) or stopped
  // ("Stopped", secondary ink); otherwise none.
  const last = running ? undefined : steps.at(-1);
  const outcome = !last
    ? undefined
    : last.lifecycleStatus === "interrupted"
      ? { word: t("Stopped"), tone: "secondary" }
      : failed(last)
        ? { word: t("Failed"), tone: "danger" }
        : undefined;
  // One finished search reads as its own row ("Searched the web query"); its
  // results open under it.
  const lone =
    !running &&
    steps.length === 1 &&
    isSearchItem(steps[0]) &&
    steps[0].type === "webSearch"
      ? steps[0]
      : undefined;
  const loneLine = lone ? stepLine(lone) : undefined;
  const loneSources = lone ? searchSources(lone) : [];
  // While running, only the latest steps show once there are enough of them.
  const windowed = running && steps.length > STEP_WINDOW;
  const hiddenCount = windowed ? steps.length - STEP_WINDOW : 0;
  const shownSteps = windowed && !allSteps ? steps.slice(-STEP_WINDOW) : steps;
  const expandable = lone ? loneSources.length > 0 : steps.length > 0;
  // A finished group closes to its row; the thought steps inside open by
  // default when it is opened.
  const open = expandable && (userOpen ?? running);
  if (!running && steps.length === 1 && isWebFetch(steps[0]))
    return <WebFetchRow item={steps[0]} />;
  if (!running && !departing && !steps.length && !thoughtSeconds(normalized))
    return null;
  const head = (
    <>
      {running ? (
        <ClayMark motion={phase === "tools" ? "tumble" : "breathe"} />
      ) : (
        departing && (
          <span className="chat-steps-mark-depart" aria-hidden="true">
            <ClayMark />
          </span>
        )
      )}
      {loneLine ? (
        <span className="activity-label-morph lone-step">
          <span className="activity-label">{loneLine.text}</span>
          {loneLine.name && (
            <span className="chat-step-name">{loneLine.name}</span>
          )}
        </span>
      ) : (
        <ActivityLabel
          phase={running && phase !== "approval" ? "thinking" : undefined}
          afterMark={!running}
        >
          {label}
        </ActivityLabel>
      )}
      {outcome && (
        <span className="chat-steps-outcome" data-tone={outcome.tone}>
          {outcome.word}
        </span>
      )}
      {running && <ActivityElapsed startedAt={turn.createdAt} />}
      {expandable && <ChevronRight size={12} aria-hidden="true" />}
    </>
  );
  return (
    <>
      <div
        className="chat-steps"
        data-running={running || undefined}
        data-open={open || undefined}
      >
        {expandable ? (
          <button
            type="button"
            className="chat-steps-head"
            aria-expanded={open}
            aria-controls={cardId}
            onClick={() => setUserOpen(!open)}
          >
            {head}
          </button>
        ) : (
          <div className="chat-steps-head">{head}</div>
        )}
        <Collapsible
          id={cardId}
          open={open}
          className="chat-steps-collapse"
          exitMs={STEP_MOTION_MS}
        >
          <div className="chat-steps-card-wrap">
            {lone ? (
              <div className="chat-steps-card chat-steps-results">
                <ResultRows sources={loneSources} />
              </div>
            ) : (
              <div className="chat-steps-card">
                <StepsList
                  steps={shownSteps}
                  hidden={hiddenCount}
                  allSteps={allSteps}
                  onAllSteps={() => setAllSteps((value) => !value)}
                  live={turn.status === "inProgress"}
                  pendingItemId={
                    phase === "approval"
                      ? steps.filter(itemIsRunning).at(-1)?.id
                      : undefined
                  }
                  turn={turn}
                  onArtifact={onArtifact}
                />
              </div>
            )}
          </div>
        </Collapsible>
      </div>
      {/* While a page is being written the row says so; its card comes when it
         is done. */}
      {changes.length > 0 && !running && (
        <div className="chat-steps-files">
          <FileChangeCards items={changes} onArtifact={onArtifact} />
        </div>
      )}
      {made.length > 0 && !running && (
        <div className="chat-steps-files">
          <Suspense fallback={null}>
            {made.map((item) => (
              <GeneratedImageCard
                key={item.id}
                savedPath={item.savedPath as string}
                platform={app?.snapshot.platform}
                onArtifact={onArtifact}
                onError={app?.report}
                onNotify={app?.notify}
              />
            ))}
          </Suspense>
        </div>
      )}
    </>
  );
}
