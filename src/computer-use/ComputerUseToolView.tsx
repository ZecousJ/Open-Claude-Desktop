import { useContext, useState } from "react";
import { Square, ChevronRight } from "../ui/glyphs";
import { AppIcon } from "../ui/app-icon";
import type { Item } from "../../shared/types";
import { itemIsRunning } from "../../shared/activity";
import { ActivityMark } from "../transcript/TurnActivity";
import { ShortcutPlatform } from "../ui/Tooltip";
import {
  resultIsError,
  resultScreenshots,
  resultText,
  toolTitle,
  withoutHeader,
  type ResultShot,
  type ToolPhase,
} from "./labels";
import { ScreenshotLightbox, useScreenshot } from "./ScreenshotLightbox";
import { formatText } from "../i18n";

const object = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Where a computer-use call stands. */
export function toolPhase(item: Item): ToolPhase {
  if (itemIsRunning(item)) return "running";
  if (item.lifecycleStatus === "interrupted") return "stopped";
  if (
    item.status === "failed" ||
    item.lifecycleStatus === "failed" ||
    resultIsError(item.result)
  )
    return "failed";
  return "done";
}

/**
 * A call to the built-in computer-use server in the transcript: what
 * Claudex did in words ("Took a screenshot of Notes"), the screenshot it
 * took under the row, and the details (input, result text) when opened.
 * No capture of the original's rows exists (visual provisional).
 */
export function ComputerUseToolView({ item }: { item: Item }) {
  const mac = useContext(ShortcutPlatform) === "darwin";
  const phase = toolPhase(item);
  const args = object(item.arguments) ?? {};
  const text = resultText(item.result);
  const output = withoutHeader(text);
  const error =
    typeof object(item.error)?.message === "string"
      ? (object(item.error)!.message as string)
      : phase === "failed"
        ? text
        : undefined;
  const title = toolTitle(item.tool, args, phase, {
    resultText: text,
    mac,
  });
  const shots = phase === "done" ? resultScreenshots(item.result) : [];
  const input =
    item.arguments === null || item.arguments === undefined
      ? undefined
      : JSON.stringify(item.arguments, null, 2);
  return (
    <div className="cu-tool" data-phase={phase}>
      <details
        className={`activity mcp-tool-activity${phase === "failed" ? " failed" : ""}${phase === "done" ? " is-plain" : ""}`}
      >
        <summary>
          {phase === "running" ? (
            <ActivityMark phase="tools" />
          ) : phase === "failed" ? (
            <AppIcon name="WarningCircle" size={15} />
          ) : phase === "stopped" ? (
            <Square size={13} />
          ) : null}
          <span className="mcp-tool-title">{title}</span>
          <ChevronRight size={13} />
        </summary>
        <div className="activity-body mcp-tool-body">
          {input && input !== "{}" && (
            <section>
              <strong>Input</strong>
              <pre>{input}</pre>
            </section>
          )}
          {error ? (
            <section className="mcp-tool-error">
              <strong>Error</strong>
              <pre>{error}</pre>
            </section>
          ) : (
            output && (
              <section>
                <strong>Output</strong>
                <pre>{output}</pre>
              </section>
            )
          )}
          {!input && !error && !output && (
            <p>
              {phase === "running"
                ? "Waiting for tool output…"
                : item.resultOmitted
                  ? "Large result omitted from this transcript"
                  : "No output"}
            </p>
          )}
        </div>
      </details>
      {phase === "failed" && error && (
        <p className="cu-tool-reason">{error.split("\n", 1)[0]}</p>
      )}
      {shots.length > 0 && (
        <div className="cu-shots">
          {shots.map((shot, index) => (
            <ScreenshotThumb
              key={"id" in shot ? shot.id : index}
              shot={shot}
              title={title}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ScreenshotThumb({ shot, title }: { shot: ResultShot; title: string }) {
  const url = useScreenshot(shot, "thumb");
  const [open, setOpen] = useState(false);
  if (url === null)
    return <p className="cu-shot-missing">Screenshot no longer available</p>;
  return (
    <>
      <button
        type="button"
        className="cu-shot"
        aria-label={formatText("Open screenshot: {title}", { title })}
        disabled={!url}
        onClick={() => setOpen(true)}
      >
        {url && <img src={url} alt="" />}
      </button>
      {open && (
        <ScreenshotLightbox
          shot={shot}
          title={title}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
