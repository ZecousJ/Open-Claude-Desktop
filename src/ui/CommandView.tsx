import { MarkdownRenderer as ReactMarkdown } from "./MarkdownRenderer";
import { useRehypeHighlight } from "./lazy-highlight";
import { ChevronRight } from "./glyphs";
import type { Item } from "../../shared/types";
import { itemIsRunning } from "../../shared/activity";
import {
  ActivityMark,
  ActivityElapsed,
  ActivityLabel,
} from "../transcript/TurnActivity";
import { ShellSource } from "../transcript/tools/shell-highlight";
export function CommandActivity({
  item,
  startedAt,
  needsInput,
}: {
  item: Item;
  startedAt?: number;
  needsInput?: boolean;
}) {
  const running = itemIsRunning(item);
  const interrupted = item.lifecycleStatus === "interrupted";
  const failed =
    item.lifecycleStatus === "failed" ||
    item.status === "failed" ||
    (typeof item.exitCode === "number" && item.exitCode !== 0);
  return (
    <details className={`command-activity ${failed ? "failed" : ""}`}>
      <summary>
        {running && <ActivityMark phase="tools" />}
        <ActivityLabel phase={running ? "tools" : undefined}>
          {needsInput
            ? "Needs your input"
            : running
              ? "Running a command"
              : interrupted
                ? "Command stopped"
                : failed
                  ? "Command failed"
                  : "Ran a command"}
        </ActivityLabel>
        {running && startedAt != null && (
          <ActivityElapsed startedAt={startedAt} />
        )}
        <ChevronRight size={12} />
      </summary>
      <CommandCard item={item} />
    </details>
  );
}
export function CommandCard({ item }: { item: Item }) {
  const failed =
    item.lifecycleStatus === "failed" ||
    item.status === "failed" ||
    (typeof item.exitCode === "number" && item.exitCode !== 0);
  const shell =
    String(item.shell ?? "")
      .split(/[\\/]/)
      .at(-1) ||
    /^\s*(?:\/\S+\/)?(bash|zsh|sh|pwsh|powershell)(?:\s|$)/.exec(
      item.command ?? "",
    )?.[1] ||
    // The card's language tag reads "bash".
    (/Windows/.test(globalThis.navigator?.userAgent ?? "")
      ? "powershell"
      : "bash");
  const language = /powershell|pwsh/i.test(shell) ? "powershell" : "bash";
  const highlight = useRehypeHighlight(language !== "bash");
  // A fence longer than any source run prevents command text from closing it.
  const fence = "`".repeat(
    Math.max(
      3,
      ...[...(item.command ?? "").matchAll(/`+/g)].map((m) => m[0].length + 1),
    ),
  );
  return (
    <div className="command-card">
      <div className="command-language">{shell}</div>
      <div className="command-source">
        {language === "bash" ? (
          <pre>
            <code>
              <ShellSource source={item.command ?? ""} />
            </code>
          </pre>
        ) : (
          <ReactMarkdown rehypePlugins={highlight ? [highlight] : []}>
            {`${fence}${language}\n${item.command ?? ""}\n${fence}`}
          </ReactMarkdown>
        )}
      </div>
      <div className="command-output-label">Output</div>
      <pre className="command-output">
        {/* Empty output leaves the area under "Output" blank, running or not
            (normalized-command-group-001 @14s; a running Code card also shows
            nothing, R-0791). */}
        {item.aggregatedOutput ?? ""}
      </pre>
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
  );
}
