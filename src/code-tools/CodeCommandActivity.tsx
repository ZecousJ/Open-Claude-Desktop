import { ChevronRight } from "../ui/glyphs";
import type { Item } from "../../shared/types";
import { itemIsRunning } from "../../shared/activity";
import { ShellSource } from "../transcript/tools/shell-highlight";
import {
  commandKind,
  commandState,
  failed as commandFailed,
  toolSummaryParts,
} from "./code-tool-model";
import { commandDescriptionText } from "./tool-description-text";
import { commandSubject } from "./command-subject";
import { sanitizeDescription } from "../../shared/tool-description";
import { listSeparator, t } from "../i18n";
import { useEffect, useState } from "react";
import {
  useTranscriptViewContext,
  verboseOpen,
} from "../transcript-view/transcript-view-store";

/**
 * A summary with its file names brighter than the verbs: "Read" #8a8a88,
 * "README.md" #f3f3f3; "Editing" then "app.js".
 */
export function ToolSummaryText({ items }: { items: Item[] }) {
  const parts = toolSummaryParts(items);
  return (
    <>
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 && listSeparator()}
          {part.verb}
          {part.name && (
            <>
              {" "}
              <span className="code-file-name">{part.name}</span>
            </>
          )}
        </span>
      ))}
    </>
  );
}

export function shellTitle(item: Item) {
  const shell =
    String(item.shell ?? "")
      .split(/[\\/]/)
      .at(-1)
      ?.toLowerCase() ?? "";
  return /powershell|pwsh/.test(shell)
    ? "PowerShell"
    : shell === "zsh"
      ? "Zsh"
      : shell === "sh"
        ? "Shell"
        : "Bash";
}

/**
 * The git operation reader (shared/git-operation.ts) loads with the first
 * command row, off the window's first load; rows drawn before it arrives
 * keep their plain wording until they draw again.
 */
type GitOperations = {
  of: typeof import("../../shared/git-operation").gitOperationOf;
  verb: typeof import("../../shared/git-operation").gitOperationVerb;
};
let gitOperations: GitOperations | undefined;
let loadingGit: Promise<GitOperations> | undefined;
function useGitOperations() {
  const [, setLoaded] = useState(Boolean(gitOperations));
  useEffect(() => {
    if (gitOperations) return;
    let live = true;
    loadingGit ??= import("../../shared/git-operation").then((module) => {
      gitOperations = {
        of: module.gitOperationOf,
        verb: module.gitOperationVerb,
      };
      return gitOperations;
    });
    void loadingGit.then(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, []);
}

/**
 * A command row's title: the model's own description first, as written while
 * running, past tense when done, "Failed to …" when it failed. A git commit,
 * push, branch or pull request reads as that ("Pushed to main"). Otherwise
 * "Ran", "Running" or "Failed to run" and the command's short form in code
 * ("Ran git status"), or "a command" when it has none. Reads, searches and
 * listings are named from Codex's parsed actions; a stopped command says so.
 */
export function commandLabel(item: Item) {
  const state = commandState(item);
  // Polling a background terminal reads as "Reading task output ›"; Codex
  // reports that call as an interaction with the running process.
  if (
    item.source === "unifiedExecInteraction" &&
    state !== "failed" &&
    state !== "interrupted"
  )
    return state === "running" ? "Reading task output" : "Read task output";
  const described = commandDescriptionText(item, state, true);
  if (described) return described;
  if (state === "interrupted") return "Command stopped";
  if (state === "completed") {
    const operation = gitOperations?.of(item);
    if (operation && gitOperations)
      return (
        <>
          {t(gitOperations.verb(operation))}{" "}
          <span className="code-file-name">{operation.meta}</span>
        </>
      );
  }
  // Reads, searches and listings are named from Codex's parsed actions.
  if (commandKind(item) !== "command" && state !== "failed")
    return <ToolSummaryText items={[item]} />;
  const subject = commandSubject(
    typeof item.command === "string" ? item.command : undefined,
  );
  const verb =
    state === "running"
      ? "Running"
      : state === "failed"
        ? "Failed to run"
        : "Ran";
  if (!subject) return `${verb} a command`;
  return (
    <>
      {t(verb)} <code className="code-command-subject">{subject}</code>
    </>
  );
}

/**
 * A background command's row: "Background command started" and what it is, the
 * model's description or the command's short form.
 */
export function backgroundLabel(item: Item) {
  const subject =
    sanitizeDescription(item.description) ||
    commandSubject(typeof item.command === "string" ? item.command : undefined);
  return subject
    ? `${t("Background command started")} · ${subject}`
    : t("Background command started");
}

/**
 * Code-mode command disclosure: summary row, "Bash" card, `$` source box, plain
 * output. A command Codex still lists as a background terminal becomes a row
 * that opens the Background tasks panel.
 */
export function CodeCommandActivity({
  item,
  background = false,
  onOpenBackground,
}: {
  item: Item;
  background?: boolean;
  onOpenBackground?: () => void;
}) {
  const view = useTranscriptViewContext();
  useGitOperations();
  if (background && onOpenBackground)
    return (
      <button
        type="button"
        className="code-command code-background-row"
        onClick={onOpenBackground}
        title={item.processId ? `Task ${item.processId}` : undefined}
      >
        <span className="code-command-label">{backgroundLabel(item)}</span>
        <ChevronRight size={16} strokeWidth={1.75} />
      </button>
    );
  const running = itemIsRunning(item);
  const failed = commandFailed(item);
  const output = String(item.aggregatedOutput ?? "").replace(/\n+$/, "");
  const label = commandLabel(item);
  // A long description is cut to one line; the full sentence stays reachable.
  const described = commandDescriptionText(item, commandState(item), true);
  return (
    <details className="code-command" open={verboseOpen(view)}>
      <summary>
        <span
          className="code-command-label"
          data-running={running || undefined}
          data-failed={(failed && !running) || undefined}
          title={described}
        >
          {label}
        </span>
        <ChevronRight size={16} strokeWidth={1.75} />
      </summary>
      <div className="code-bash-card">
        <div className="code-bash-title">{shellTitle(item)}</div>
        <pre className="code-bash-source">
          <span className="code-bash-prompt">$ </span>
          <ShellSource source={item.command ?? ""} />
        </pre>
        {output && <pre className="code-bash-output">{output}</pre>}
        {failed && (
          <div className="command-error" role="status">
            {item.exitCode != null
              ? `Exit code ${item.exitCode}`
              : String(
                  item.error?.message ??
                    item.error ??
                    "The command could not be completed.",
                )}
          </div>
        )}
      </div>
    </details>
  );
}
