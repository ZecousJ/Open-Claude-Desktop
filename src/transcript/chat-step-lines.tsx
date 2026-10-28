import { useConversationServices } from "../conversation/ConversationServices";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Check } from "../ui/glyphs";
import type { Item } from "../../shared/types";
import { itemIsRunning } from "../../shared/activity";
import { commandState, failed, toolKind } from "../code-tools/code-tool-model";
import { commandDescriptionText } from "../code-tools/tool-description-text";
import { AppContext } from "../app/AppContext";
import { isSearchItem, searchQueries } from "./tools/WebSearchView";
import { sourceHost } from "../citations/citations";
import { formatText, t } from "../i18n";
import { toolRunningLabel } from "./tools/tool-running-label";
import { isWebFetch } from "../../shared/web-fetch-item";
import { webFetchLabel } from "./tools/WebFetchRow";
import { thoughtLine } from "./thought-line";
import { thinkingQuote } from "../code-tools/ThinkingInline";
import { AppIcon } from "../ui/app-icon";
import { Markdown } from "../ui/components";

/** One step's line: its words, and the file it touched in brighter ink. */
export function stepLine(item: Item): { text: string; name?: string } {
  const running = itemIsRunning(item);
  if (isWebFetch(item))
    return { text: webFetchLabel(item).replace(/<\/?b>/g, "") };
  if (item.type === "reasoning") return { text: thoughtLine(item) };
  if (item.type === "imageView")
    return {
      text:
        (typeof item.description === "string" && item.description.trim()) ||
        (running ? "Viewing an image" : "Viewed an image"),
      name: typeof item.path === "string" ? baseName(item.path) : undefined,
    };
  if (item.type === "webSearch" && !isSearchItem(item)) {
    // Opening a page, or searching within one: "Opened a page  site.example".
    const action = item.action as { type?: string; url?: string } | undefined;
    const within = action?.type === "findInPage";
    const host = action?.url ? sourceHost(action.url) : undefined;
    return {
      text: running
        ? within
          ? "Searching within a page"
          : "Reading a page…"
        : within
          ? "Searched within a page"
          : "Opened a page",
      ...(host ? { name: host } : {}),
    };
  }
  if (item.type === "webSearch") {
    const query = searchQueries(item).join(" · ");
    const x = item.searchTool === "x_search";
    return {
      text: running
        ? x
          ? "Searching X"
          : "Searching the web"
        : item.lifecycleStatus === "interrupted"
          ? x
            ? "Stopped searching X"
            : "Stopped searching the web"
          : failed(item)
            ? x
              ? "X search failed"
              : "Failed to search the web"
            : `Searched ${x ? "X" : "the web"}`,
      ...(query ? { name: query } : {}),
    };
  }
  if (item.type === "imageGeneration")
    return {
      text: running
        ? "Generating an image"
        : item.status === "failed"
          ? "Image generation failed"
          : "Generated an image",
      name:
        typeof item.savedPath === "string" && item.savedPath
          ? baseName(item.savedPath)
          : undefined,
    };
  if (item.type === "fileChange") {
    const paths = [...new Set((item.changes ?? []).map((c) => c.path))];
    const created = (item.changes ?? []).every(
      (c) => (typeof c.kind === "string" ? c.kind : c.kind?.type) === "add",
    );
    if (running)
      return { text: created ? "Creating a file…" : "Editing a file…" };
    return {
      text: created ? "Created" : "Edited",
      name: paths.length === 1 ? baseName(paths[0]) : `${paths.length} files`,
    };
  }
  if (item.type === "commandExecution") {
    if (item.lifecycleStatus === "interrupted")
      return { text: "Command stopped" };
    const described = commandDescriptionText(item, commandState(item));
    if (!running && failed(item) && !described)
      return { text: "Command failed" };
    if (described) return { text: described };
    const kind = toolKind(item);
    if (kind === "read") {
      const path = (
        item.commandActions as { type: string; name?: string; path?: string }[]
      )?.find((a) => a.type === "read");
      const name = path?.name || (path?.path ? baseName(path.path) : "");
      return name
        ? running
          ? { text: formatText("Reading {fileName}…", { fileName: name }) }
          : { text: "Read", name }
        : { text: running ? "Reading a file…" : "Read a file" };
    }
    if (running && kind === "search") return { text: "Searching files…" };
    if (running && kind === "list") return { text: "Listing files…" };
    return { text: running ? "Running a command…" : "Ran a command" };
  }
  if (TOOL_TYPES.includes(item.type))
    return {
      text: running
        ? toolRunningLabel(item)
        : item.tool?.trim()
          ? formatText("Used {name}", { name: item.tool.trim() })
          : "Used a tool",
    };
  return { text: running ? "Using a tool" : "Used a tool" };
}

/**
 * A thought's text in its opened step. Past 200px it is clamped behind a 40px
 * fade with Show more (shown on hover, always on touch screens); the clamp
 * opens to the text's height and closes back over 300ms.
 */
export function ThinkingActions({ text }: { text: string }) {
  const services = useConversationServices();
  const app = useContext(AppContext);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  const label = t(copied ? "Copied" : "Copy as quote");
  return (
    <div
      className="thinking-actions"
      role="group"
      aria-label={t("Thinking actions")}
    >
      <button
        type="button"
        className="thinking-copy"
        aria-label={label}
        title={label}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() =>
          void services
            .copyText(thinkingQuote(text))
            .then(() => {
              if (!mounted.current) return;
              setCopied(true);
              app?.notify(t("Copied"));
              clearTimeout(timer.current);
              timer.current = setTimeout(() => setCopied(false), 2000);
            })
            .catch(app?.report ?? (() => {}))
        }
      >
        {copied ? (
          <Check size={16} aria-hidden="true" />
        ) : (
          <AppIcon name="Copy" />
        )}
      </button>
    </div>
  );
}

export function StepThought({ text }: { text: string }) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const element = inner.current;
    if (!element) return;
    const measure = () => setHeight(element.scrollHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const long = height > THOUGHT_CLAMP_HEIGHT;
  return (
    <div
      className="chat-step-thought"
      data-clamped={(long && !expanded) || undefined}
    >
      <div
        className="chat-step-thought-clip"
        style={
          long
            ? { maxHeight: expanded ? height : THOUGHT_CLAMP_HEIGHT }
            : undefined
        }
      >
        <div ref={inner}>
          <Markdown text={text} />
        </div>
      </div>
      {long && (
        <button
          type="button"
          className="chat-step-thought-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("Show less") : t("Show more")}
        </button>
      )}
    </div>
  );
}

export const TOOL_TYPES = ["mcpToolCall", "dynamicToolCall"];

export const baseName = (path: string) => path.split(/[\\/]/).at(-1) ?? path;

/** A thought taller than this is clamped behind a fade with Show more. */
export const THOUGHT_CLAMP_HEIGHT = 200;
