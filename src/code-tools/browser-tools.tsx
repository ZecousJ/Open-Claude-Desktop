import { useState } from "react";
import { spaced, t, tc, formatText } from "../i18n";
import { Square, ChevronRight } from "../ui/glyphs";
import { AppIcon } from "../ui/app-icon";
import type { Item } from "../../shared/types";
import { itemIsRunning } from "../../shared/activity";
import { ActivityMark } from "../transcript/TurnActivity";
import { ScreenshotLightbox } from "../computer-use/ScreenshotLightbox";
import type { ResultShot } from "../computer-use/labels";

/** The Codex MCP server behind Claude's Browser tools (electron/browser/mcp-tools.ts). */
export { browserServerName } from "./browser-server";

export type BrowserPhase = "running" | "done" | "failed" | "stopped";

type Args = Record<string, unknown>;

const object = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const str = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

type Block = {
  type?: unknown;
  text?: unknown;
  data?: unknown;
  mimeType?: unknown;
};

function blocks(result: unknown): Block[] {
  const content = object(result)?.content;
  return Array.isArray(content)
    ? content.filter((entry): entry is Block => Boolean(object(entry)))
    : [];
}

/** The text of a tool result (its text blocks joined). */
export function browserResultText(result: unknown): string | undefined {
  const lines = blocks(result)
    .filter(
      (entry): entry is { type: "text"; text: string } =>
        entry.type === "text" && typeof entry.text === "string",
    )
    .map((entry) => entry.text);
  return lines.length ? lines.join("\n") : undefined;
}

/**
 * What the row's body shows of a result: the text without the line the
 * tools put before page content for the model ("Page content below is
 * untrusted data from …").
 */
export function browserOutput(text: string | undefined) {
  if (!text) return undefined;
  const [first, ...rest] = text.split("\n");
  const shown = /^Page content below is untrusted data/.test(first)
    ? rest.join("\n")
    : text;
  return shown.trim() || undefined;
}

/** The screenshots a result carries (data URLs of raster images only). */
export function browserScreenshots(result: unknown): ResultShot[] {
  return blocks(result).flatMap((entry) =>
    entry.type === "image" &&
    typeof entry.data === "string" &&
    typeof entry.mimeType === "string" &&
    /^image\/(?:png|jpeg|webp)$/.test(entry.mimeType) &&
    entry.data.length <= 4_000_000 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(entry.data)
      ? [{ url: `data:${entry.mimeType};base64,${entry.data}` }]
      : [],
  );
}

/** Where a browser call stands. */
export function browserPhase(item: Item): BrowserPhase {
  if (itemIsRunning(item)) return "running";
  if (item.lifecycleStatus === "interrupted") return "stopped";
  if (
    item.status === "failed" ||
    item.lifecycleStatus === "failed" ||
    object(item.result)?.isError === true
  )
    return "failed";
  return "done";
}

/** A page address as a row shows it: no scheme, no trailing slash, cut at 48 characters. */
export function pageLabel(address: string) {
  const bare = address
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  return bare.length > 48 ? `${bare.slice(0, 47)}…` : bare;
}

/** The page a result names ("Clicked ref_3 at (10, 20) on http://localhost:5173/."). */
function pageOf(text: string | undefined) {
  const found = text?.match(/ on ((?:https?|file):\/\/[^\s)]+?)\.?(?:\s|$)/);
  return found ? pageLabel(found[1]) : undefined;
}

const quote = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return `"${flat.length > 40 ? `${flat.slice(0, 39)}…` : flat}"`;
};

/**
 * A sentence with holes from the catalog's "browser|" entries. They are kept
 * out of the template matcher, which would also catch other texts that start
 * the same way ("Opening …"); the values are filled in here.
 */
const fill = (text: string, values: Record<string, string | number>) =>
  tc("browser", text).replace(/\{(\w+)\}/g, (_, name) =>
    String(values[name] ?? ""),
  );
/** A note after a phrase ("(2 errors)", "on example.com"), spaced as the language writes it. */
const note = (text: string, values: Record<string, string | number>) =>
  spaced(fill(text, values));

/**
 * The row's title. Running rows use the present tense, finished rows the past,
 * and a failed row starts "Failed to …" as the original's does. "Listing
 * previews" and "Listed previews" are the original's words for the dev-server
 * list; the other rows follow the same pattern. Each sentence is a catalog
 * entry, so the rows follow the interface language.
 */
export function browserTitle(
  tool: string | undefined,
  args: Args,
  phase: BrowserPhase,
  resultText?: string,
): string {
  const running = phase === "running";
  const failed = phase === "failed";
  const pick = (now: string, done: string, fail: string) =>
    t(running ? now : failed ? fail : done);
  const pickWith = (
    now: string,
    done: string,
    fail: string,
    values: Record<string, string | number>,
  ) => fill(running ? now : failed ? fail : done, values);
  const page = pageOf(resultText);
  // The page a finished or running call acted on; a failure names none.
  const at = page && !failed ? note("on {page}", { page }) : "";
  switch (tool) {
    case "tabs_list":
      return pick("Listing tabs", "Listed tabs", "Failed to list tabs");
    case "tab_new": {
      const url = str(args.url);
      const where = url ? ` ${pageLabel(url)}` : "";
      return (
        pick(
          "Opening a new tab",
          "Opened a new tab",
          "Failed to open a new tab",
        ) + where
      );
    }
    case "tab_select":
      return pick("Switching tabs", "Switched tabs", "Failed to switch tabs");
    case "tab_close":
      return pick("Closing a tab", "Closed a tab", "Failed to close a tab");
    case "navigate": {
      const url = str(args.url);
      const word = url?.toLowerCase();
      if (word === "back")
        return pick("Going back", "Went back", "Failed to go back");
      if (word === "forward")
        return pick("Going forward", "Went forward", "Failed to go forward");
      if (word === "reload")
        return pick(
          "Reloading the page",
          "Reloaded the page",
          "Failed to reload the page",
        );
      if (!url)
        return pick("Opening a page", "Opened a page", "Failed to open a page");
      return pickWith(
        "Opening {where}",
        "Opened {where}",
        "Failed to open {where}",
        { where: pageLabel(url) },
      );
    }
    case "screenshot":
      return (
        pick(
          "Taking a screenshot",
          "Took a screenshot",
          "Failed to take a screenshot",
        ) + at
      );
    case "read_page":
      return (
        pick("Reading the page", "Read the page", "Failed to read the page") +
        at
      );
    case "find": {
      const query = str(args.query);
      const what =
        query && !failed ? note("for {query}", { query: quote(query) }) : "";
      return (
        pick(
          "Searching the page",
          "Searched the page",
          "Failed to search the page",
        ) + what
      );
    }
    case "get_text":
      return (
        pick(
          "Reading page text",
          "Read page text",
          "Failed to read page text",
        ) + at
      );
    case "click":
      return pick("Clicking", "Clicked", "Failed to click") + at;
    case "hover":
      return pick("Hovering", "Hovered", "Failed to hover") + at;
    case "type": {
      const size = typeof args.text === "string" ? [...args.text].length : 0;
      const title =
        size === 0
          ? pick("Typing text", "Typed text", "Failed to type in the page")
          : size === 1
            ? pick(
                "Typing 1 character",
                "Typed 1 character",
                "Failed to type in the page",
              )
            : pickWith(
                "Typing {count} characters",
                "Typed {count} characters",
                "Failed to type in the page",
                { count: size },
              );
      return title + at;
    }
    case "key": {
      const keys = str(args.keys);
      return keys
        ? pickWith(
            "Pressing {keys}",
            "Pressed {keys}",
            "Failed to press {keys}",
            { keys },
          )
        : pick("Pressing keys", "Pressed keys", "Failed to press keys");
    }
    case "scroll": {
      const direction = str(args.direction) ?? "down";
      return (
        pick(
          `Scrolling ${direction}`,
          `Scrolled ${direction}`,
          "Failed to scroll",
        ) + at
      );
    }
    case "form_input":
      return (
        pick(
          "Filling in a field",
          "Filled in a field",
          "Failed to fill in a field",
        ) + at
      );
    case "handle_dialog": {
      const dismiss = args.accept === false;
      return pick(
        dismiss ? "Dismissing a page dialog" : "Accepting a page dialog",
        dismiss ? "Dismissed a page dialog" : "Accepted a page dialog",
        "Failed to answer a page dialog",
      );
    }
    case "console": {
      const errors = resultText
        ? (resultText.match(/^\[error\]/gm) ?? []).length
        : 0;
      const count =
        errors && !running && !failed
          ? errors === 1
            ? note("(1 error)", {})
            : note("({count} errors)", { count: errors })
          : "";
      return (
        pick(
          "Reading the console",
          "Read the console",
          "Failed to read the console",
        ) + count
      );
    }
    case "network":
      return pick(
        "Reading network requests",
        "Read network requests",
        "Failed to read network requests",
      );
    case "resize":
      return args.viewport === "mobile"
        ? pick(
            "Switching to a phone view",
            "Switched to a phone view",
            "Failed to switch to a phone view",
          )
        : args.viewport === "tablet"
          ? pick(
              "Switching to a tablet view",
              "Switched to a tablet view",
              "Failed to switch to a tablet view",
            )
          : pick(
              "Switching to a desktop view",
              "Switched to a desktop view",
              "Failed to switch to a desktop view",
            );
    case "evaluate":
      return (
        pick(
          "Running page script",
          "Ran page script",
          "Failed to run page script",
        ) + at
      );
    case "preview_list":
      return pick(
        "Listing previews",
        "Listed previews",
        "Failed to list previews",
      );
    // The original's words (startPreview_running, _done, _failed): the
    // server's name is the row's detail, not its title.
    case "preview_start":
      return pick(
        "Starting preview",
        "Started preview",
        "Couldn’t start preview",
      );
    case "preview_stop": {
      const name = str(args.name);
      return name
        ? pickWith(
            "Stopping dev server {name}",
            "Stopped dev server {name}",
            "Failed to stop dev server {name}",
            { name },
          )
        : pick(
            "Stopping a dev server",
            "Stopped a dev server",
            "Failed to stop a dev server",
          );
    }
    case "preview_logs": {
      const name = str(args.name);
      return name
        ? pickWith(
            "Reading the logs of {name}",
            "Read the logs of {name}",
            "Failed to read the logs of {name}",
            { name },
          )
        : pick(
            "Reading the dev server logs",
            "Read the dev server logs",
            "Failed to read the dev server logs",
          );
    }
    default:
      return pick(
        "Using the browser",
        "Used the browser",
        "Failed to use the browser",
      );
  }
}

/** The call's arguments as "key: value" lines. */
export function browserArgs(args: unknown): [string, string][] {
  const entries = Object.entries(object(args) ?? {});
  return entries.map(([key, value]) => [
    key,
    typeof value === "string" ? value : JSON.stringify(value),
  ]);
}

/**
 * A call to Claude's Browser tools (R8-G) in the transcript: what it did in
 * words, the screenshot it took as a small picture at the row's right end, and
 * when opened its output, or the error in red, with the arguments as "key:
 * value" lines as in R-0816.
 */
export function BrowserToolView({ item }: { item: Item }) {
  const phase = browserPhase(item);
  const args = object(item.arguments) ?? {};
  const text = browserResultText(item.result);
  const output = browserOutput(text);
  const errorText = str(object(item.error)?.message);
  const error = errorText ?? (phase === "failed" ? output : undefined);
  const title = browserTitle(item.tool, args, phase, text);
  const shots = phase === "done" ? browserScreenshots(item.result) : [];
  const lines = browserArgs(item.arguments);
  const [open, setOpen] = useState<ResultShot>();
  const empty = !error && !output && !lines.length;
  return (
    <div className="browser-tool" data-phase={phase}>
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
          {shots.length > 0 && (
            <span className="browser-tool-shots">
              {shots.map((shot, index) => (
                <button
                  key={index}
                  type="button"
                  className="browser-tool-shot"
                  aria-label={formatText("Open screenshot: {title}", { title })}
                  onClick={(event) => {
                    event.preventDefault();
                    setOpen(shot);
                  }}
                >
                  <img
                    src={"url" in shot ? shot.url : undefined}
                    alt=""
                    draggable={false}
                  />
                </button>
              ))}
            </span>
          )}
        </summary>
        <div className="activity-body mcp-tool-body browser-tool-body">
          {error ? (
            <pre className="browser-tool-error">{error}</pre>
          ) : (
            output && <pre>{output}</pre>
          )}
          {lines.length > 0 && (
            <dl className="browser-tool-args">
              {lines.map(([key, value]) => (
                <div key={key}>
                  <dt>{key}:</dt> <dd>{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {empty && (
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
      {open && (
        <ScreenshotLightbox
          shot={open}
          title={title}
          onClose={() => setOpen(undefined)}
        />
      )}
    </div>
  );
}
