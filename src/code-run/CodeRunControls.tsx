import { useContext } from "react";
import { Play, Square, SquareTerminal } from "../ui/glyphs";
import { t } from "../i18n";
import {
  cancelRun,
  CodeRunContext,
  runCommand,
  runKey,
  runKind,
  runnableCommand,
  useCodeRun,
} from "./run-store";
import "./code-run.css";

/** The code block's Play / Cancel button (beside Copy). */
export function CodeRunButton({
  language,
  code,
}: {
  language: string;
  code: string;
}) {
  const host = useContext(CodeRunContext);
  const key = host ? runKey(host.conversationId, code) : "";
  const run = useCodeRun(key);
  if (!host) return null;
  const kind = runKind(language, host.windows);
  const command = runnableCommand(code);
  if (!kind || !command) return null;
  if (run?.running)
    return (
      <button
        type="button"
        className="small-action code-run"
        aria-label={t("Cancel")}
        title={t("Running — click to cancel")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => cancelRun(key, host.conversationId)}
      >
        <Square size={12} />
      </button>
    );
  const label =
    kind === "powershell" ? t("Run in PowerShell") : t("Run in terminal");
  return (
    <button
      type="button"
      className="small-action code-run"
      aria-label={label}
      title={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => void runCommand(key, host.conversationId, command)}
    >
      <Play size={13} />
    </button>
  );
}

/** The run's output under the block, with Open in terminal. */
export function CodeRunOutput({ code }: { code: string }) {
  const host = useContext(CodeRunContext);
  const run = useCodeRun(host ? runKey(host.conversationId, code) : "");
  if (!host || !run || (!run.output && !run.error && !run.running)) return null;
  return (
    <div className="code-run-output">
      <div className="code-run-box">
        <pre>
          {run.error ? (
            <span className="code-run-error">{run.error}</span>
          ) : (
            run.output
          )}
        </pre>
      </div>
      {run.sessionId && (
        <button
          type="button"
          className="code-run-open"
          aria-label={t("Open in terminal")}
          title={t("Open in terminal")}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => host.openTerminal(run.sessionId!)}
        >
          <SquareTerminal size={15} />
        </button>
      )}
    </div>
  );
}
