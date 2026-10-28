import { Square, ChevronRight } from "../../ui/glyphs";
import { AppIcon } from "../../ui/app-icon";
import { ToolStepDetails } from "./ToolStepDetails";
import type { Item } from "../../../shared/types";
import { itemIsRunning } from "../../../shared/activity";
import { ActivityMark } from "../TurnActivity";
import { Suspense } from "react";
import { isMemoryTool } from "./memory-tool-kind";
import { lazyPiece, preloadPiece } from "../../ui/lazy-piece";

// Memory rows load with the first one shown.
const MemoryToolView = lazyPiece(
  () => import("./MemoryToolView"),
  "MemoryToolView",
);
/** For server rendering (tests): have the memory row ready. */
export const preloadMemoryToolView = () => preloadPiece(MemoryToolView);
import { WebFetchError } from "./WebFetchError";
import { isWebFetch } from "../../../shared/web-fetch-item";
import { WebFetchRow } from "./WebFetchRow";
import {
  isCodeExecution,
  codeExecutionLabel,
} from "../../composer/code/code-execution-label";
import { formatText, t } from "../../i18n";
import { toolRunningLabel } from "./tool-running-label";
import { McpResourceLinks } from "./McpResourceLinks";

function imageSource(value: string) {
  return /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]*={0,2}$/.test(
    value,
  ) && value.length < 2_000_100
    ? value
    : undefined;
}
export function DynamicToolView({
  item,
  step,
  needsInput,
}: {
  item: Item;
  /** A row of Chat's steps card (ToolStepDetails). */
  step?: boolean;
  needsInput?: boolean;
}) {
  if (!needsInput && isWebFetch(item)) return <WebFetchRow item={item} />;
  // Claudex's own memory tool reads as memory, not as a raw call.
  if (!needsInput && isMemoryTool(item))
    return (
      <Suspense fallback={null}>
        <MemoryToolView item={item} />
      </Suspense>
    );
  const running = itemIsRunning(item),
    failed =
      item.status === "failed" ||
      item.success === false ||
      item.lifecycleStatus === "failed";
  const stopped = item.lifecycleStatus === "interrupted";
  const name =
    [item.namespace, item.tool].filter(Boolean).join(" · ") || "Tool";
  const title = needsInput
    ? t("Needs your input")
    : running
      ? isCodeExecution(item)
        ? codeExecutionLabel()
        : toolRunningLabel(item)
      : failed
        ? formatText("{name} failed", { name })
        : stopped
          ? formatText("{name} stopped", { name })
          : formatText("Used {name}", { name });
  const input =
    item.arguments === null || item.arguments === undefined
      ? ""
      : JSON.stringify(item.arguments, null, 2);
  const output = Array.isArray(item.contentItems)
    ? item.contentItems.filter((part) => part?.type !== "resource_link")
    : [];
  return (
    <>
      <details
        className={`activity dynamic-tool-activity is-plain${failed ? " failed" : ""}`}
      >
        <summary>
          {running ? (
            <ActivityMark phase="tools" />
          ) : failed ? (
            <AppIcon name="WarningCircle" size={15} />
          ) : stopped ? (
            <Square size={13} />
          ) : null}
          <span className="dynamic-tool-title">{title}</span>
          <WebFetchError item={item} />
          <ChevronRight size={13} />
        </summary>
        {step ? (
          <ToolStepDetails
            args={item.arguments}
            outputs={output.map((value: any) =>
              value?.type === "inputText" && typeof value.text === "string"
                ? { type: "text" as const, text: value.text }
                : value?.type === "inputImage" &&
                    typeof value.imageUrl === "string" &&
                    imageSource(value.imageUrl)
                  ? {
                      type: "image" as const,
                      url: imageSource(value.imageUrl)!,
                    }
                  : {
                      type: "label" as const,
                      label:
                        value?.type === "inputImage"
                          ? "Image result available in the tool response"
                          : "Unsupported output type",
                    },
            )}
            empty={
              running
                ? "Waiting for tool output…"
                : item.resultOmitted
                  ? "Large result omitted from this transcript"
                  : "No output"
            }
          />
        ) : (
          <div className="activity-body dynamic-tool-body">
            {input && (
              <section>
                <strong>Input</strong>
                <pre>{input}</pre>
              </section>
            )}
            {!!output.length && (
              <section>
                <strong>Output</strong>
                {output.map((value: any, index: number) =>
                  value?.type === "inputText" &&
                  typeof value.text === "string" ? (
                    <pre key={index}>{value.text}</pre>
                  ) : value?.type === "inputImage" &&
                    typeof value.imageUrl === "string" &&
                    imageSource(value.imageUrl) ? (
                    <img
                      key={index}
                      src={imageSource(value.imageUrl)}
                      alt="Tool image result"
                    />
                  ) : (
                    <p key={index}>
                      {value?.type === "inputImage"
                        ? "Image result available in the tool response"
                        : "Unsupported output type"}
                    </p>
                  ),
                )}
              </section>
            )}
            {!input && !output.length && (
              <p>
                {running
                  ? "Waiting for tool output…"
                  : item.resultOmitted
                    ? "Large result omitted from this transcript"
                    : "No output"}
              </p>
            )}
          </div>
        )}
      </details>
      <McpResourceLinks item={item} />
    </>
  );
}
