import { ChevronRight } from "../../ui/glyphs";
import type { Item } from "../../../shared/types";
import { itemIsRunning } from "../../../shared/activity";
import { ShellSource } from "../tools/shell-highlight";
import {
  commandLabel,
  ToolSummaryText,
} from "../../code-tools/CodeCommandActivity";
import { failed as commandFailed } from "../../code-tools/code-tool-model";

/**
 * One call in an agent's tool list: a collapsed row ("Listed repository files
 * ›", "Read README.md ›"); failed rows are red and open to the `$` command and
 * its red output.
 */
function AgentToolRow({ item }: { item: Item }) {
  const running = itemIsRunning(item);
  const failed = commandFailed(item) && !running;
  const output = String(item.aggregatedOutput ?? "").replace(/\n+$/, "");
  const error =
    failed && !output
      ? item.exitCode != null
        ? `Exit code ${item.exitCode}`
        : String(item.error?.message ?? item.error ?? "")
      : "";
  return (
    <details className="agent-tool-row" data-failed={failed || undefined}>
      <summary>
        <span className="agent-tool-label" data-running={running || undefined}>
          {commandLabel(item)}
        </span>
        <ChevronRight size={15} strokeWidth={1.75} />
      </summary>
      <div className="agent-tool-body">
        <pre className="agent-tool-source">
          <span className="agent-tool-prompt">$ </span>
          <ShellSource source={item.command ?? ""} />
        </pre>
        {(output || error) && (
          <pre className="agent-tool-output">{output || error}</pre>
        )}
      </div>
    </details>
  );
}

/**
 * An agent's consecutive tool calls as one summary ("Ran 3 commands (1 failed),
 * read 3 files ⌄") over a bordered list of collapsed rows, as in the
 * reference's agent transcript.
 */
export function AgentCommandGroup({ commands }: { commands: Item[] }) {
  const running = commands.some(itemIsRunning);
  return (
    <details
      className={`agent-transcript-commands${running ? " is-running" : ""}`}
    >
      <summary>
        <span>
          <ToolSummaryText items={commands} />
        </span>
        <ChevronRight size={16} />
      </summary>
      <div className="agent-tool-list">
        {commands.map((item, index) => (
          <AgentToolRow key={`${item.id}:${index}`} item={item} />
        ))}
      </div>
    </details>
  );
}
