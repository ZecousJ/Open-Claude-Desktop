import { useConversationServices } from "../conversation/ConversationServices";
import {
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronRight } from "../ui/glyphs";
import type { Item, Turn } from "../../shared/types";
import { itemIsRunning } from "../../shared/activity";
import { ActivityLabel, useLinger } from "./TurnActivity";
import { Collapsible } from "../ui/Collapsible";
import { thoughtSeconds } from "./CodeTurnStatus";
import { failed, toolKind } from "../code-tools/code-tool-model";
import { generatedArtifact } from "../artifacts/generatedArtifact";
import {
  generatedImageArtifact,
  ViewedImageThumbnail,
} from "./tools/SessionToolView";
import { AppContext } from "../app/AppContext";
import { McpToolView } from "./tools/McpToolView";
import { DynamicToolView } from "./tools/DynamicToolView";
import { ResultRows, searchSources } from "./tools/WebSearchView";
import { t } from "../i18n";
import { thoughtLabel } from "./thought-label";
import { lazyPiece } from "../ui/lazy-piece";
import { isWebFetch } from "../../shared/web-fetch-item";
import { WebFetchRow } from "./tools/WebFetchRow";
import { useThoughtExpansion } from "./thought-expansion";
import { toolGroupSummary } from "./tools/tool-group-summary";
export { thoughtLine } from "./thought-line";

export const GeneratedImageCard = lazyPiece(
  () => import("../artifacts/GeneratedImageCard"),
);
import { CommandCard, Markdown, type Artifact } from "../ui/components";
import { stepLine, ThinkingActions, StepThought } from "./chat-step-lines";
import { TOOL_TYPES, baseName } from "./chat-step-lines";

/** The items a group lists as steps: commands, tools, file changes and thoughts. */
export function isChatStep(item: Item) {
  return (
    item.type === "commandExecution" ||
    item.type === "fileChange" ||
    // A picture the agent looked at is a step, not a card.
    item.type === "imageView" ||
    item.type === "imageGeneration" ||
    // A search is a step too: "Searched the web latest stable Rust release".
    item.type === "webSearch" ||
    TOOL_TYPES.includes(item.type) ||
    (item.type === "reasoning" &&
      Boolean(item.summary?.some((text) => text.trim())))
  );
}

/** Finished group labels. */
export function chatStepsSummary(items: Item[], notes = true) {
  const commands = items.filter((item) => item.type === "commandExecution");
  const steps = items.filter((item) => toolKind(item));
  // One command that did not finish says so.
  if (notes && steps.length === 1 && commands.length === 1) {
    if (commands[0].lifecycleStatus === "interrupted")
      return t("Command stopped");
    if (failed(commands[0])) return t("Command failed");
  }
  const summary = toolGroupSummary(items);
  if (summary) return summary;
  const seconds = thoughtSeconds(items);
  return seconds ? thoughtLabel(seconds) : t("Thought process");
}

/** How long a step takes to open, close, arrive or leave (timeline-expand). */
export const STEP_MOTION_MS = 200;
/** The working mark's departure when a group finishes: it holds, then fades. */
export const MARK_DEPART_MS = 420;
/** While a group runs, only its latest steps show once it has this many. */
export const STEP_WINDOW = 2;

/**
 * The rows a list shows while some of them leave: a row that drops out of
 * `items` stays in its place, marked leaving, for `exitMs`; new rows take
 * their place in `items`' order.
 */
export function useLeavingRows<T extends { id: string }>(
  items: T[],
  exitMs: number,
): { item: T; leaving: boolean }[] {
  const ids = items.map((item) => item.id);
  const last = useRef(new Map<string, T>());
  const [rows, setRows] = useState(() => ({
    present: ids,
    all: ids,
    gone: new Map<string, T>(),
  }));
  let current = rows;
  if (rows.present.join("\n") !== ids.join("\n")) {
    current = mergeRows(rows, ids, last.current);
    setRows(current);
  }
  last.current = new Map(items.map((item) => [item.id, item]));
  useEffect(() => {
    if (!rows.gone.size) return;
    const timer = window.setTimeout(
      () =>
        setRows((value) => ({
          ...value,
          all: value.all.filter((id) => !value.gone.has(id)),
          gone: new Map(),
        })),
      exitMs,
    );
    return () => window.clearTimeout(timer);
  }, [rows.gone, exitMs]);
  const byId = new Map(items.map((item) => [item.id, item]));
  return current.all.flatMap((id) => {
    const item = byId.get(id) ?? current.gone.get(id);
    return item ? [{ item, leaving: !byId.has(id) }] : [];
  });
}

/** The next row order: kept rows in place, removed ones leaving, new ones in. */
export function mergeRows<T>(
  rows: { present: string[]; all: string[]; gone: Map<string, T> },
  ids: string[],
  previous: Map<string, T>,
) {
  const keep = new Set(ids);
  const seen = new Set(rows.all);
  const gone = new Map(rows.gone);
  const all: string[] = [];
  let next = 0;
  for (const id of rows.all) {
    if (keep.has(id)) {
      while (next < ids.length && ids[next] !== id) {
        if (!seen.has(ids[next])) all.push(ids[next]);
        next++;
      }
      all.push(id);
      next++;
      gone.delete(id);
      continue;
    }
    const item = gone.get(id) ?? previous.get(id);
    if (item !== undefined) {
      gone.set(id, item);
      all.push(id);
    }
  }
  for (; next < ids.length; next++)
    if (!all.includes(ids[next])) all.push(ids[next]);
  return { present: ids, all, gone };
}

/**
 * The quiet working dots at the end of a running step's row; with the pointer
 * on the row (or focus) they give way to its caret.
 */
function StepEnd({ running }: { running: boolean }) {
  if (!running) return <ChevronRight size={12} aria-hidden="true" />;
  return (
    <span className="chat-step-end" aria-hidden="true">
      <span className="quiet-dots">
        <span />
        <span />
        <span />
      </span>
      <ChevronRight size={12} />
    </span>
  );
}

export function ChatStep({
  item,
  live,
  needsInput = false,
  turn,
  onArtifact,
}: {
  item: Item;
  /** The turn is still running (a running step shimmers). */
  live: boolean;
  needsInput?: boolean;
  turn: Turn;
  onArtifact: (artifact: Artifact) => void;
}) {
  const app = useContext(AppContext);
  const services = useConversationServices();
  const [userOpen, setUserOpen] = useState<boolean>();
  const [thoughtOpen, setThoughtOpen] = useThoughtExpansion(
    `${turn.id}:thinking:${item.id}`,
  );
  const bodyId = useId();
  const running = live && itemIsRunning(item);
  // A running step with something to show peeks at it, dimmed and faded at the
  // bottom; it opens fully when clicked and folds away when done. Folded again
  // by hand while it still runs, it peeks again, and the peek follows what is
  // being written: its newest lines, not the first few.
  const peeking = running && userOpen !== true;
  const peekShown = useLinger(peeking, STEP_MOTION_MS);
  const peek = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = peek.current;
    if (element) element.scrollTop = element.scrollHeight;
  });
  // Connector calls keep their own rows (arguments, results, errors).
  if (isWebFetch(item)) return <WebFetchRow item={item} />;
  if (TOOL_TYPES.includes(item.type))
    return (
      <div className="chat-step chat-step-tool">
        {item.type === "mcpToolCall" ? (
          <McpToolView item={item} step needsInput={needsInput} />
        ) : (
          <DynamicToolView item={item} step needsInput={needsInput} />
        )}
      </div>
    );
  const line = needsInput ? { text: t("Needs your input") } : stepLine(item);
  // A written page opens from its row.
  const document =
    item.type === "fileChange"
      ? (item.generatedFiles ?? []).find(
          (f) => f.state === "ready" && ["html", "svg"].includes(f.language),
        )
      : undefined;
  const artifact = document && generatedArtifact(document);
  let body: ReactNode = null;
  if (item.type === "commandExecution") body = <CommandCard item={item} />;
  else if (item.type === "reasoning") {
    const text = item.summary?.join("\n\n") ?? "";
    body = (
      <div className="chat-step-thinking-detail">
        <div className="chat-step-thinking-text">
          {running ? (
            <div className="chat-step-thought">
              <Markdown text={text} />
            </div>
          ) : (
            <StepThought text={text} />
          )}
        </div>
        <ThinkingActions text={text} />
      </div>
    );
  } else if (item.type === "webSearch") {
    const sources = searchSources(item);
    body = sources.length ? (
      <div className="chat-step-results">
        <ResultRows sources={sources} />
      </div>
    ) : null;
  } else if (item.type === "fileChange" && !artifact)
    body = (item.changes ?? []).some((c) => c.diff) ? (
      <div className="chat-step-diff">
        {(item.changes ?? []).map((c, index) => (
          <pre key={index}>{c.diff}</pre>
        ))}
      </div>
    ) : null;
  const content = (
    <>
      <ActivityLabel
        className="chat-step-text"
        quiet
        phase={running ? "tools" : undefined}
      >
        {line.text}
      </ActivityLabel>
      {line.name && <span className="chat-step-name">{line.name}</span>}
      <StepEnd running={running} />
    </>
  );
  if (item.type === "imageView" && typeof item.path === "string") {
    const path: string = item.path;
    // The viewed picture's thumbnail at the row's right end, opening it large.
    return (
      <div className="chat-step chat-step-viewed-image">
        <button
          type="button"
          className="chat-step-row"
          disabled={Boolean(services.imagePreviewUnavailable)}
          title={services.imagePreviewUnavailable}
          onClick={() => {
            const conversationId = app?.activeId ?? services.conversationId;
            if (!conversationId) return;
            services
              .viewedImageSnapshot(conversationId, path)
              .then((snapshot) => {
                if (snapshot)
                  onArtifact(
                    generatedImageArtifact(snapshot, path, baseName(path)),
                  );
              })
              .catch(app?.report ?? (() => {}));
          }}
        >
          {content}
        </button>
        <ViewedImageThumbnail
          path={path}
          name={baseName(path)}
          onArtifact={onArtifact}
        />
      </div>
    );
  }
  if (item.type === "imageGeneration" && typeof item.savedPath === "string") {
    const path: string = item.savedPath;
    return (
      <div className="chat-step">
        <button
          type="button"
          className="chat-step-row"
          disabled={Boolean(services.imagePreviewUnavailable)}
          title={services.imagePreviewUnavailable}
          onClick={() => {
            services
              .imageGenerationSnapshot(path)
              .then((snapshot) => {
                if (snapshot)
                  onArtifact(
                    generatedImageArtifact(snapshot, path, baseName(path)),
                  );
              })
              .catch(app?.report);
          }}
        >
          {content}
        </button>
      </div>
    );
  }
  if (artifact)
    return (
      <div className="chat-step">
        <button
          type="button"
          className="chat-step-row"
          onClick={() => onArtifact(artifact)}
        >
          {content}
        </button>
      </div>
    );
  if (!body)
    return (
      <div className="chat-step">
        <div className="chat-step-row">{content}</div>
      </div>
    );
  const open = item.type === "reasoning" ? thoughtOpen : (userOpen ?? false);
  return (
    <div
      className="chat-step"
      data-open={open || undefined}
      data-thinking={item.type === "reasoning" || undefined}
    >
      <button
        type="button"
        className="chat-step-row"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() =>
          item.type === "reasoning" ? setThoughtOpen(!open) : setUserOpen(!open)
        }
      >
        {content}
      </button>
      {peekShown && !open ? (
        <div
          ref={peek}
          id={bodyId}
          className="chat-step-peek"
          data-leaving={!peeking || undefined}
          onClick={() => setUserOpen(true)}
        >
          <div className="chat-step-body">{body}</div>
        </div>
      ) : (
        <Collapsible
          id={bodyId}
          open={open}
          className="chat-step-collapse"
          exitMs={STEP_MOTION_MS}
        >
          <div className="chat-step-body">{body}</div>
        </Collapsible>
      )}
    </div>
  );
}

/** The steps card's first row while some steps are hidden. */
export const STEPS_HEADER = "\u0000steps-header";

/**
 * A row of the steps card: a step, or the card's "{n} steps" header. A row
 * that comes after the card first showed opens into place; one that leaves
 * folds away (timeline-expand, 200ms; chat-transcript.css), so the rows
 * under it glide up.
 */
export function StepSlot({
  leaving,
  arriving,
  children,
}: {
  leaving: boolean;
  arriving: boolean;
  children: ReactNode;
}) {
  const [arrived] = useState(arriving);
  return (
    <div
      className="chat-step-slot"
      data-arriving={arrived || undefined}
      data-leaving={leaving || undefined}
      inert={leaving || undefined}
    >
      <div>{children}</div>
    </div>
  );
}
