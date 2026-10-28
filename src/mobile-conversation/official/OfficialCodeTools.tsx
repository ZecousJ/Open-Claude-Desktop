import type { ReactNode } from "react";
import type { Item } from "../../../shared/types";
import {
  gitOperationOf,
  gitOperationVerb,
} from "../../../shared/git-operation";
import { itemIsRunning } from "../../../shared/activity";
import { sanitizeDescription } from "../../../shared/tool-description";
import type { CodeToolGroupProps } from "../../transcript/transcript-slots";
import type { Artifact } from "../../ui/ArtifactTypes";
import {
  backgroundLabel,
  commandLabel,
  shellTitle,
  ToolSummaryText,
} from "../../code-tools/CodeCommandActivity";
import {
  FileDiffBlock,
  fileChangeFailure,
  fileChangeParts,
} from "../../code-tools/CodeFileChange";
import {
  codeToolCallLabel,
  codeToolFailed,
  codeToolName,
} from "../../code-tools/CodeToolCall";
import {
  failed as commandFailed,
  toolSummary,
} from "../../code-tools/code-tool-model";
import { fileChangeDiff } from "../../diff/diff-model";
import { commandDescriptionText } from "../../code-tools/tool-description-text";
import { generatedArtifact } from "../../artifacts/generatedArtifact";
import { thoughtSeconds } from "../../transcript/CodeTurnStatus";
import { thoughtLabel } from "../../transcript/thought-label";
import { Markdown } from "../../ui/components";
import { AppIcon } from "../../ui/app-icon";
import { t, tf, useT } from "../../i18n";
import { OfficialSheet, useSheetStack, type SheetPage } from "./OfficialSheet";
import {
  searchQueries,
  searchSources,
} from "../../transcript/tools/WebSearchView";
import { stepContent } from "./step-content";

const basename = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** Whether a finished call ended badly (a failed command, edit or tool). */
function callFailed(item: Item) {
  if (itemIsRunning(item)) return false;
  if (item.type === "commandExecution") return commandFailed(item);
  if (item.type === "fileChange") return Boolean(fileChangeFailure(item));
  return codeToolFailed(item);
}

/**
 * One tool call's words on its row and in the Tool calls list: the verb and,
 * for a file, its name. The text is Claudex's own per-call wording, localised.
 * A failed call keeps its finished wording: the official app has no "Failed to
 * …" text (only `ccr_tool_status_failed` "Failed"), the row shows a failed
 * mark.
 */
function callLabel(item: Item, background: boolean): ReactNode {
  // A source control action reads as the official ccr rows do ("Created PR
  // #12", "Pushed to main", "Committed 1a2b3c4"): the verb, then its subject
  // (qix.f / fuw.j; shared/git-operation.ts).
  const operation = background ? undefined : gitOperationOf(item);
  if (operation)
    return (
      <>
        {t(gitOperationVerb(operation))}{" "}
        <span className="official-code-subject">{operation.meta}</span>
      </>
    );
  if (item.type === "commandExecution") {
    if (background) return backgroundLabel(item);
    if (commandFailed(item) && !itemIsRunning(item))
      return commandDescriptionText(item, "completed") ?? t("Ran a command");
    return commandLabel(item);
  }
  if (item.type === "fileChange") {
    const failure = fileChangeFailure(item);
    const changes = item.changes ?? [];
    const name = failure ? failure.target : fileChangeParts(item).name;
    const verb = failure
      ? changes.every(
          (change) =>
            (typeof change.kind === "string"
              ? change.kind
              : change.kind?.type) === "add",
        )
        ? "Created"
        : "Edited"
      : fileChangeParts(item).verb;
    return (
      <>
        {t(verb)}
        {name && (
          <>
            {" "}
            <span className="official-code-subject">{name}</span>
          </>
        )}
      </>
    );
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall")
    return codeToolCallLabel(item, true);
  return toolSummary([item]);
}

/** The tool's name as the ToolCallDetail sheet titles itself. */
function toolTitle(item: Item) {
  if (item.type === "commandExecution") return shellTitle(item);
  if (item.type === "fileChange") {
    const changes = item.changes ?? [];
    return changes.length > 0 &&
      changes.every(
        (change) =>
          (typeof change.kind === "string"
            ? change.kind
            : change.kind?.type) === "add",
      )
      ? "Write"
      : "Edit";
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall")
    return codeToolName(item);
  if (item.type === "webSearch") return "WebSearch";
  return t("Steps");
}

const errorText = (item: Item) =>
  typeof item.error === "string"
    ? item.error
    : typeof item.error?.message === "string"
      ? item.error.message
      : undefined;

/**
 * The ToolCallDetail page. A command shows the official Command card with its
 * Output or Error; the model's own description heads the card. A file edit
 * shows its diff; any other call shows its Inputs and its Result or Error.
 */
function ToolDetail({
  item,
  onArtifact,
  onClose,
}: {
  item: Item;
  onArtifact: (artifact: Artifact) => void;
  onClose: () => void;
}) {
  useT();
  const running = itemIsRunning(item);
  const section = (title: string, body: ReactNode, danger = false) => (
    <section key={title} data-error={danger || undefined}>
      <h3>{title}</h3>
      {body}
    </section>
  );
  if (item.type === "commandExecution") {
    const bad = commandFailed(item);
    const output = String(item.aggregatedOutput ?? "").replace(/\n+$/, "");
    const reason =
      output ||
      (bad
        ? item.exitCode != null
          ? `Exit code ${item.exitCode}`
          : (errorText(item) ?? "")
        : "");
    const description = sanitizeDescription(item.description);
    return (
      <div className="official-code-detail">
        {description && (
          <p className="official-code-description">{description}</p>
        )}
        {section(t("Command"), <pre>{item.command}</pre>)}
        {reason &&
          section(bad ? t("Error") : t("Output"), <pre>{reason}</pre>, bad)}
        {!reason && running && (
          <p className="official-code-note">{t("Waiting for tool output…")}</p>
        )}
      </div>
    );
  }
  if (item.type === "fileChange") {
    const failure = fileChangeFailure(item);
    const files = (item.changes ?? []).map(fileChangeDiff);
    return (
      <div className="official-code-detail">
        {failure && section(t("Error"), <pre>{failure.reason}</pre>, true)}
        {files.map((file, index) => {
          const generated = item.generatedFiles?.find(
            (entry) =>
              entry.path === file.path ||
              entry.path.endsWith(`/${basename(file.path)}`),
          );
          const artifact = generated && generatedArtifact(generated);
          return (
            <FileDiffBlock
              key={`${file.path}:${index}`}
              file={file}
              onOpen={
                artifact
                  ? () => {
                      onClose();
                      onArtifact(artifact);
                    }
                  : undefined
              }
            />
          );
        })}
      </div>
    );
  }
  if (item.type === "webSearch") {
    const queries = searchQueries(item);
    const sources = searchSources(item);
    return (
      <div className="official-code-detail">
        {queries.length > 0 &&
          section(t("Inputs"), <pre>{queries.join("\n")}</pre>)}
        {sources.length > 0 &&
          section(
            t("Result"),
            <pre>
              {sources
                .map((source) => [source.title, source.url].join("\n"))
                .join("\n\n")}
            </pre>,
          )}
        {!queries.length && !sources.length && (
          <p className="official-code-note">
            {running ? t("Waiting for tool output…") : t("No output")}
          </p>
        )}
      </div>
    );
  }
  const content = stepContent(item);
  const bad = codeToolFailed(item) || content.failed;
  return (
    <div className="official-code-detail">
      {content.request && section(t("Inputs"), <pre>{content.request}</pre>)}
      {content.error && section(t("Error"), <pre>{content.error}</pre>, true)}
      {content.response.length > 0 &&
        section(
          bad && !content.error ? t("Error") : t("Result"),
          content.response.map((entry, index) =>
            entry.type === "image" ? (
              <img key={index} src={entry.url} alt="" />
            ) : entry.type === "text" ? (
              <pre key={index}>{entry.text}</pre>
            ) : (
              <p key={index}>{entry.label}</p>
            ),
          ),
          bad && !content.error,
        )}
      {!content.request && !content.error && !content.response.length && (
        <p className="official-code-note">
          {running ? t("Waiting for tool output…") : t("No output")}
        </p>
      )}
    </div>
  );
}

/**
 * Code's folded tool calls as the official app draws them. A lone call is
 * worded "verb subject"; several give the summary ("Read 2 files, ran a
 * command"). A tap opens the call's own detail sheet when there is one call,
 * else the "Tool calls (N)" sheet listing them, each opening its detail.
 */
export function OfficialCodeTools({
  items,
  turnStatus,
  background,
  onOpenBackground,
  onArtifact,
}: CodeToolGroupProps) {
  useT();
  const sheet = useSheetStack();
  const normalized = items.map((item) =>
    turnStatus !== "inProgress" && itemIsRunning(item)
      ? { ...item, lifecycleStatus: turnStatus }
      : item,
  );
  const single = normalized.length === 1 ? normalized[0] : undefined;
  const inBackground = Boolean(single && background.has(single.id));
  const running = normalized.some(itemIsRunning);
  const bad = normalized.some(callFailed);
  const label = single ? (
    callLabel(single, inBackground)
  ) : (
    <ToolSummaryText items={normalized} />
  );
  const detail = (item: Item): SheetPage => ({
    key: item.id,
    title: toolTitle(item),
    body: () => (
      <ToolDetail item={item} onArtifact={onArtifact} onClose={sheet.close} />
    ),
  });
  const list: SheetPage = {
    key: "list",
    title: toolSummary(normalized) || t("Steps"),
    body: () => (
      <>
        <h3 className="official-code-list-title">
          {tf("Tool calls ({n})", { n: normalized.length })}
        </h3>
        <ul className="official-step-list">
          {normalized.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="official-step"
                onClick={() => sheet.push(item.id)}
              >
                <span className="official-step-text">
                  {callLabel(item, false)}
                </span>
                {callFailed(item) ? (
                  <span className="official-step-mark">{t("Failed")}</span>
                ) : (
                  <span className="official-step-caret" aria-hidden="true">
                    <AppIcon name="CaretRight" />
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </>
    ),
  };
  return (
    <>
      <div className="official-code-tools">
        <button
          type="button"
          className="official-code-row"
          data-running={running || undefined}
          data-failed={(bad && !running) || undefined}
          aria-haspopup={inBackground ? undefined : "dialog"}
          onClick={() => {
            if (inBackground) onOpenBackground();
            else sheet.open(single ? single.id : list.key);
          }}
        >
          <span
            className={`official-code-label${running ? " official-shimmer" : ""}`}
          >
            {label}
          </span>
          {bad && !running && (
            <span
              className="official-code-failed"
              role="img"
              aria-label={t("Failed")}
            >
              <AppIcon name="Warning" />
            </span>
          )}
          <span className="official-steps-caret" aria-hidden="true">
            <AppIcon name="CaretRight" />
          </span>
        </button>
      </div>
      <OfficialSheet
        pages={sheet.pages.flatMap((key) => {
          if (key === list.key) return [list];
          const item = normalized.find((entry) => entry.id === key);
          return item ? [detail(item)] : [];
        })}
        onBack={sheet.back}
        onClose={sheet.close}
      />
    </>
  );
}

/**
 * A standalone thought in a Code turn: the same collapsed row, "Thought for
 * 12s" (or "Thought process"), opening the Thought process sheet with the
 * thinking itself. While it streams the row reads "Thinking…" and shimmers.
 */
export function OfficialCodeThought({ item }: { item: Item }) {
  useT();
  const sheet = useSheetStack();
  const running = itemIsRunning(item);
  const seconds = thoughtSeconds([item]);
  const page: SheetPage = {
    key: item.id,
    title: t("Thought process"),
    body: () => (
      <div className="official-thought">
        <Markdown text={item.summary?.join("\n\n") ?? ""} />
      </div>
    ),
  };
  return (
    <>
      <div className="official-code-tools">
        <button
          type="button"
          className="official-code-row"
          aria-haspopup="dialog"
          onClick={() => sheet.open(page.key)}
        >
          <span
            className={`official-code-label${running ? " official-shimmer" : ""}`}
          >
            {running
              ? t("Thinking…")
              : seconds
                ? thoughtLabel(seconds)
                : t("Thought process")}
          </span>
          <span className="official-steps-caret" aria-hidden="true">
            <AppIcon name="CaretRight" />
          </span>
        </button>
      </div>
      <OfficialSheet
        pages={sheet.pages.length ? [page] : []}
        onBack={sheet.back}
        onClose={sheet.close}
      />
    </>
  );
}
