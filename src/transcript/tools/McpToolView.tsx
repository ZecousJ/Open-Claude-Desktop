import { Square, ChevronRight } from "../../ui/glyphs";
import { AppIcon } from "../../ui/app-icon";
import type { Item } from "../../../shared/types";
import { itemIsRunning } from "../../../shared/activity";
import { ActivityMark } from "../TurnActivity";
import { computerUseServerName } from "../../../shared/computer-use";
import { ComputerUseToolView } from "../../computer-use/ComputerUseToolView";
import { browserServerName } from "../../code-tools/browser-server";
import { lazyPiece, preloadPiece } from "../../ui/lazy-piece";

// Browser tool rows load with the first one shown.
const BrowserToolView = lazyPiece(
  () => import("../../code-tools/browser-tools"),
  "BrowserToolView",
);
/** For server rendering (tests): have the browser rows ready. */
export const preloadBrowserToolView = () => preloadPiece(BrowserToolView);
import { ToolStepDetails } from "./ToolStepDetails";
import { Suspense, useContext } from "react";
import { AppContext } from "../../app/AppContext";
import { embeddedWidget, widgetUri } from "../../../shared/widget";
import { formatText, t } from "../../i18n";
import { WebFetchError } from "./WebFetchError";
import { isWebFetch } from "../../../shared/web-fetch-item";
import { WebFetchRow } from "./WebFetchRow";
import {
  isCodeExecution,
  codeExecutionLabel,
} from "../../composer/code/code-execution-label";
import { McpResourceLinks } from "./McpResourceLinks";

type Content =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "resource"; uri: string; text?: string }
  | { type: "other"; label: string };
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function displayContent(value: unknown): Content {
  const entry = object(value);
  if (!entry) return { type: "other", label: "Unrecognized result" };
  if (entry.type === "text" && typeof entry.text === "string")
    return { type: "text", text: entry.text };
  if (
    entry.type === "image" &&
    typeof entry.data === "string" &&
    typeof entry.mimeType === "string" &&
    /^image\/(?:png|jpeg|webp|gif)$/.test(entry.mimeType) &&
    entry.data.length <= 2_000_000 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(entry.data)
  )
    return {
      type: "image",
      url: `data:${entry.mimeType};base64,${entry.data}`,
    };
  const resource = object(entry.resource);
  if (entry.type === "resource" && resource && typeof resource.uri === "string")
    return {
      type: "resource",
      uri: resource.uri,
      text: typeof resource.text === "string" ? resource.text : undefined,
    };
  return {
    type: "other",
    label: `${typeof entry.type === "string" ? entry.type : "Unknown"} result`,
  };
}
export function mcpOutput(item: Item): Content[] {
  const result = object(item.result),
    content = Array.isArray(result?.content) ? result.content : [];
  const parsed = content
    .filter((part: any) => part?.type !== "resource_link")
    .map(displayContent);
  if (
    result?.structuredContent !== null &&
    result?.structuredContent !== undefined
  ) {
    const text = JSON.stringify(result.structuredContent, null, 2);
    if (text) parsed.push({ type: "text", text });
  }
  return parsed;
}
export function McpToolView({
  item,
  step,
  needsInput,
}: {
  item: Item;
  /** A row of Chat's steps card (ToolStepDetails). */
  step?: boolean;
  needsInput?: boolean;
}) {
  if (needsInput)
    return <GenericMcpToolView item={item} step={step} needsInput />;
  if (isWebFetch(item)) return <WebFetchRow item={item} />;
  // Claudex's own computer-use server has its own rows (R10).
  if (item.server === computerUseServerName)
    return <ComputerUseToolView item={item} />;
  // And so are Claude's Browser tools (R8-G).
  if (item.server === browserServerName)
    return (
      <Suspense fallback={null}>
        <BrowserToolView item={item} />
      </Suspense>
    );
  return <GenericMcpToolView item={item} step={step} needsInput={needsInput} />;
}
function GenericMcpToolView({
  item,
  step,
  needsInput,
}: {
  item: Item;
  step?: boolean;
  needsInput?: boolean;
}) {
  const controller = useContext(AppContext);
  const running = itemIsRunning(item),
    failed = item.status === "failed" || item.lifecycleStatus === "failed";
  const stopped = item.lifecycleStatus === "interrupted";
  const app = object(item.appContext);
  const action =
    typeof app?.actionName === "string" && app.actionName.trim()
      ? app.actionName.trim()
      : undefined;
  const name = [item.server, item.tool].filter(Boolean).join(" · ") || "Tool";
  // A finished call is a plain grey row, "Used Claude Docs: Edit doc ›", with
  // no icon.
  const title = needsInput
    ? t("Needs your input")
    : running
      ? (action ??
        (isCodeExecution(item)
          ? codeExecutionLabel()
          : formatText("Using {name}", { name })))
      : failed
        ? formatText("{name} failed", { name })
        : stopped
          ? formatText("{name} stopped", { name })
          : (action ??
            formatText("Used {name}", {
              name: `${item.server ?? t("a tool")}${item.tool ? `: ${item.tool}` : ""}`,
            }));
  const output = mcpOutput(item);
  const input =
    item.arguments === null || item.arguments === undefined
      ? undefined
      : JSON.stringify(item.arguments, null, 2);
  const error = object(item.error)?.message;
  return (
    <>
      <details
        className={`activity mcp-tool-activity is-plain${failed ? " failed" : ""}`}
      >
        <summary>
          {running ? (
            <ActivityMark phase="tools" />
          ) : failed ? (
            <AppIcon name="WarningCircle" size={15} />
          ) : stopped ? (
            <Square size={13} />
          ) : null}
          <span className="mcp-tool-title">{title}</span>
          <WebFetchError item={item} />
          {running && typeof item.progress === "string" && (
            <small className="mcp-tool-progress" role="status">
              {item.progress}
            </small>
          )}
          <ChevronRight size={13} />
        </summary>
        {controller &&
          !controller.snapshot.settings.disableNonessentialServices &&
          (widgetUri(item) ||
            widgetUri(item.result) ||
            embeddedWidget(item.result)) && (
            <button
              onClick={() => {
                controller.toolPanels.setWidgetId(item.id);
                controller.setPanel("widget");
              }}
            >
              {t("Widget")}
            </button>
          )}
        {step ? (
          <ToolStepDetails
            args={item.arguments}
            error={typeof error === "string" ? error : undefined}
            outputs={output.map((entry) =>
              entry.type === "text"
                ? entry
                : entry.type === "image"
                  ? entry
                  : entry.type === "resource"
                    ? {
                        type: "text" as const,
                        text: [entry.uri, entry.text]
                          .filter(Boolean)
                          .join("\n"),
                      }
                    : { type: "label" as const, label: entry.label },
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
          <div className="activity-body mcp-tool-body">
            {input && (
              <section>
                <strong>Input</strong>
                <pre>{input}</pre>
              </section>
            )}
            {typeof error === "string" && (
              <section className="mcp-tool-error">
                <strong>Error</strong>
                <pre>{error}</pre>
              </section>
            )}
            {output.length > 0 && (
              <section>
                <strong>Output</strong>
                {output.map((entry, index) =>
                  entry.type === "text" ? (
                    <pre key={index}>{entry.text}</pre>
                  ) : entry.type === "image" ? (
                    <img key={index} src={entry.url} alt="MCP tool result" />
                  ) : entry.type === "resource" ? (
                    <div className="mcp-tool-resource" key={index}>
                      <span>{entry.uri}</span>
                      {entry.text && <pre>{entry.text}</pre>}
                    </div>
                  ) : (
                    <p key={index}>{entry.label}</p>
                  ),
                )}
              </section>
            )}
            {!input && !error && !output.length && (
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
