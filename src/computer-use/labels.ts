/**
 * Words for computer use (R10) in the transcript and on the cards: the
 * title of each tool row ("Took a screenshot of Notes"), access levels and
 * key combinations. Pure, so tests can check them without a window.
 */
import {
  screenshotIdOf,
  type ComputerUseTier,
} from "../../shared/computer-use";
import { formatText, listSeparator, t, tc } from "../i18n";

export const tierLabels: Record<ComputerUseTier, string> = {
  read: "View only",
  click: "Click only",
  full: "All",
};

export type ToolPhase = "running" | "done" | "failed" | "stopped";

type Args = Record<string, unknown>;

const str = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/**
 * An app's readable name: the broker's result names it ("Notes · click ·
 * full access"); before that, the argument, with a bundle id shortened to
 * its last part (com.apple.TextEdit → TextEdit).
 */
export function appName(args: Args, resultText?: string): string | undefined {
  const header = resultText?.split("\n", 1)[0];
  const named = header?.match(/^(.+?) · [a-z_]+ · /)?.[1];
  if (named) return named;
  const raw = str(args.app);
  if (!raw) return undefined;
  return /^[a-z0-9-]+(\.[A-Za-z0-9-]+){2,}$/.test(raw)
    ? raw.split(".").at(-1)
    : raw;
}

/** "Hello world" in quotes, cut to 40 characters. */
export function quoted(text: string) {
  const flat = text.replace(/\s+/g, " ").trim();
  return `"${flat.length > 40 ? `${flat.slice(0, 39)}…` : flat}"`;
}

const macKeys: Record<string, string> = {
  super: "⌘",
  cmd: "⌘",
  command: "⌘",
  meta: "⌘",
  ctrl: "⌃",
  control: "⌃",
  alt: "⌥",
  option: "⌥",
  shift: "⇧",
};
const otherKeys: Record<string, string> = {
  super: "Win",
  cmd: "Win",
  command: "Win",
  meta: "Win",
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};
const namedKeys: Record<string, [mac: string, other: string]> = {
  return: ["↩", "Enter"],
  enter: ["↩", "Enter"],
  escape: ["Esc", "Esc"],
  esc: ["Esc", "Esc"],
  tab: ["⇥", "Tab"],
  backspace: ["⌫", "Backspace"],
  delete: ["⌦", "Delete"],
  space: ["Space", "Space"],
  up: ["↑", "Up"],
  down: ["↓", "Down"],
  left: ["←", "Left"],
  right: ["→", "Right"],
  page_up: ["Page Up", "Page Up"],
  page_down: ["Page Down", "Page Down"],
  home: ["Home", "Home"],
  end: ["End", "End"],
};

/** An xdotool key combination as people read it: "super+s" → "⌘S" (macOS) or "Win+S". */
export function keyLabel(key: string, mac: boolean) {
  const parts = key
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const labels = parts.map((part, index) => {
    const lower = part.toLowerCase();
    const modifier = (mac ? macKeys : otherKeys)[lower];
    if (modifier && index < parts.length - 1) return modifier;
    const named = namedKeys[lower];
    if (named) return mac ? named[0] : named[1];
    return part.length === 1 ? part.toUpperCase() : part;
  });
  return labels.join(mac ? "" : "+");
}

/** Apps the result of request_access granted ("Notes: granted (full access)."). */
export function grantedNames(resultText: string | undefined) {
  if (!resultText) return [];
  return [
    ...resultText.matchAll(/^(.+?): (?:granted|already granted) \(/gm),
  ].map((match) => match[1]);
}

/**
 * A sentence from the catalog; one with holes is a "computer|" entry, kept
 * out of the template matcher (which would also catch other texts that
 * start the same way, "Opening …"), and its holes are filled in here.
 */
const fill = (text: string, values: Record<string, string | number>) =>
  /\{\w+\}/.test(text)
    ? tc("computer", text).replace(/\{(\w+)\}/g, (_, name) =>
        String(values[name] ?? ""),
      )
    : t(text);

/**
 * The row's title. Running rows use the present tense, finished rows the
 * past; a failed row says what couldn't be done (its reason shows below).
 * Each sentence is a catalog sentence of its own, so a language orders the
 * app name and the action as it needs ("Taking a screenshot of {app}").
 */
export function toolTitle(
  tool: string | undefined,
  args: Args,
  phase: ToolPhase,
  options: { resultText?: string; mac?: boolean } = {},
): string {
  const { resultText, mac = true } = options;
  const app = appName(args, resultText) ?? t("an app");
  const running = phase === "running";
  const failed = phase === "failed";
  const pick = (
    now: string,
    done: string,
    fail: string,
    values: Record<string, string | number> = { app },
  ) =>
    running
      ? fill(now, values)
      : failed
        ? fill("Couldn't {action}", { action: fill(fail, values) })
        : fill(done, values);
  switch (tool) {
    case "list_apps":
      return pick("Listing apps", "Listed apps", "list apps");
    case "request_access": {
      const count = Array.isArray(args.apps) ? args.apps.length : 0;
      const apps = count
        ? formatText(count === 1 ? "{count} app" : "{count} apps", { count })
        : t("apps");
      if (phase === "done") {
        const granted = grantedNames(resultText);
        return granted.length
          ? fill("Allowed {apps}", {
              apps: granted.join(listSeparator()),
            })
          : fill("Didn't get access to {apps}", { apps });
      }
      return pick(
        "Requesting access to {apps}",
        "Requested access to {apps}",
        "request access to {apps}",
        { apps },
      );
    }
    case "list_granted_applications":
      return pick(
        "Checking allowed apps",
        "Checked allowed apps",
        "check allowed apps",
      );
    case "open_application":
      return pick("Opening {app}", "Opened {app}", "open {app}");
    case "screenshot":
      return pick(
        "Taking a screenshot of {app}",
        "Took a screenshot of {app}",
        "take a screenshot of {app}",
      );
    case "get_app_state":
      return pick("Looking at {app}", "Looked at {app}", "look at {app}");
    case "click": {
      const button = str(args.mouse_button) ?? "left";
      const count = typeof args.click_count === "number" ? args.click_count : 1;
      return button === "right"
        ? pick(
            "Right-clicking in {app}",
            "Right-clicked in {app}",
            "right-click in {app}",
          )
        : count === 2
          ? pick(
              "Double-clicking in {app}",
              "Double-clicked in {app}",
              "double-click in {app}",
            )
          : count >= 3
            ? pick(
                "Triple-clicking in {app}",
                "Triple-clicked in {app}",
                "triple-click in {app}",
              )
            : pick("Clicking in {app}", "Clicked in {app}", "click in {app}");
    }
    case "type_text": {
      const text = typeof args.text === "string" ? args.text : "";
      const what = text ? quoted(text) : t("text");
      return pick(
        "Typing {what} in {app}",
        "Typed {what} in {app}",
        "type in {app}",
        { app, what },
      );
    }
    case "press_key": {
      const key = str(args.key);
      const what = key ? keyLabel(key, mac) : t("a key");
      return pick(
        "Pressing {what} in {app}",
        "Pressed {what} in {app}",
        "press {what} in {app}",
        { app, what },
      );
    }
    case "set_value":
      return pick(
        "Setting a value in {app}",
        "Set a value in {app}",
        "set a value in {app}",
      );
    case "scroll": {
      const direction = t(str(args.direction) ?? "down");
      return pick(
        "Scrolling {direction} in {app}",
        "Scrolled {direction} in {app}",
        "scroll in {app}",
        { app, direction },
      );
    }
    case "drag":
      return pick("Dragging in {app}", "Dragged in {app}", "drag in {app}");
    case "perform_secondary_action":
      return pick(
        "Using an action in {app}",
        "Used an action in {app}",
        "use an action in {app}",
      );
    case "request_full_control":
      if (phase === "done" && resultText && /didn't allow/.test(resultText))
        return t("Full control wasn't allowed");
      return pick(
        "Asking for full control",
        "Took full control",
        "take full control",
      );
    case "release_full_control":
      return pick("Releasing control", "Released control", "release control");
    case "read_clipboard":
      return pick(
        "Reading the clipboard",
        "Read the clipboard",
        "read the clipboard",
      );
    case "write_clipboard":
      return pick(
        "Copying to the clipboard",
        "Copied to the clipboard",
        "copy to the clipboard",
      );
    default:
      return pick(
        "Using your computer",
        "Used your computer",
        "use your computer",
      );
  }
}

type Content = {
  type?: unknown;
  text?: unknown;
  data?: unknown;
  mimeType?: unknown;
};

/** A tool result's content blocks, when it has any. */
function contentOf(result: unknown): Content[] {
  const content = (result as { content?: unknown } | null | undefined)?.content;
  return Array.isArray(content)
    ? content.filter((entry): entry is Content =>
        Boolean(entry && typeof entry === "object"),
      )
    : [];
}

/**
 * A screenshot in a result: the saved copy's id (the broker adds a
 * `claudex-screenshot://` line after each image), or, for a result that
 * carries only the image itself, a data URL.
 */
export type ResultShot = { id: string } | { url: string };

export function resultScreenshots(result: unknown): ResultShot[] {
  const content = contentOf(result);
  const shots: ResultShot[] = [];
  content.forEach((entry, index) => {
    if (entry.type === "text" && typeof entry.text === "string") {
      const id = screenshotIdOf(entry.text);
      if (id) shots.push({ id });
      return;
    }
    if (
      entry.type === "image" &&
      typeof entry.data === "string" &&
      typeof entry.mimeType === "string" &&
      /^image\/(?:png|jpeg|webp)$/.test(entry.mimeType) &&
      entry.data.length <= 4_000_000 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(entry.data)
    ) {
      // The reference right after it names the saved copy.
      const next = content[index + 1];
      if (
        next?.type === "text" &&
        typeof next.text === "string" &&
        screenshotIdOf(next.text)
      )
        return;
      shots.push({ url: `data:${entry.mimeType};base64,${entry.data}` });
    }
  });
  return shots;
}

/** The result's text, without screenshot references. */
export function resultText(result: unknown): string | undefined {
  const lines = contentOf(result)
    .filter(
      (entry): entry is { type: "text"; text: string } =>
        entry.type === "text" &&
        typeof entry.text === "string" &&
        !screenshotIdOf(entry.text),
    )
    .map((entry) => entry.text);
  return lines.length ? lines.join("\n") : undefined;
}

/** A result the broker marked as an error. */
export function resultIsError(result: unknown) {
  return Boolean((result as { isError?: unknown } | null)?.isError);
}

/**
 * A result's text without the broker's first line for the model ("Notes ·
 * click · full access"): the row's title already says it.
 */
export function withoutHeader(text: string | undefined) {
  if (!text) return undefined;
  const [first, ...rest] = text.split("\n");
  if (!/^.+? · [a-z_]+ · /.test(first)) return text;
  const remaining = rest.join("\n").trim();
  return remaining || undefined;
}
