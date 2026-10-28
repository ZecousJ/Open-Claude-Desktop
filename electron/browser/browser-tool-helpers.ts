import {
  type BrowserTabState,
  type DevServerState,
} from "../../shared/browser";
import type { ClickTarget } from "./cdp";
import { ToolError } from "./browser-tool-args";

export function tabLine(tab: BrowserTabState, active: boolean) {
  const status = tab.error
    ? ` — failed: ${tab.error.description}`
    : tab.crashed
      ? " — crashed"
      : tab.loading
        ? tab.stalled
          ? " — still loading"
          : " — loading"
        : "";
  return `${tab.id}${active ? " (shown)" : ""}: ${tab.title || "Untitled"} — ${tab.url || "blank"}${status}`;
}

const modifierBits: Record<string, number> = {
  alt: 1,
  option: 1,
  ctrl: 2,
  control: 2,
  cmd: 4,
  meta: 4,
  command: 4,
  shift: 8,
};

export function modifierMask(text?: string) {
  if (!text) return 0;
  let mask = 0;
  for (const part of text
    .toLowerCase()
    .split(/[+\s]+/)
    .filter(Boolean)) {
    const bit = modifierBits[part];
    if (bit === undefined)
      throw new ToolError(`Unknown modifier key: ${part}.`);
    mask |= bit;
  }
  return mask;
}

export function target(args: {
  ref?: string;
  coordinate?: [number, number];
}): ClickTarget | undefined {
  if (args.ref) return { ref: args.ref };
  if (args.coordinate) return { x: args.coordinate[0], y: args.coordinate[1] };
  return undefined;
}

/** Keys that put characters into a field (not Enter, Tab or shortcuts). */
export function typesCharacters(keys: string) {
  return keys
    .split(/\s+/)
    .filter(Boolean)
    .some((chord) => {
      const parts = chord.split("+");
      if (
        parts.length > 1 &&
        parts.slice(0, -1).some((p) => p.toLowerCase() !== "shift")
      )
        return false;
      const last = parts[parts.length - 1];
      return [...last].length === 1 || last.toLowerCase() === "space";
    });
}

/**
 * Chords that paste the clipboard (cmd/ctrl+v, shift+Insert): what the
 * person copied would go to the page, so it is asked on other sites.
 */
export function pastesClipboard(keys: string) {
  return keys
    .split(/\s+/)
    .filter(Boolean)
    .some((chord) => {
      const parts = chord.toLowerCase().split("+");
      const last = parts[parts.length - 1];
      const mods = parts.slice(0, -1);
      if (last === "v")
        return mods.some((m) =>
          ["cmd", "meta", "command", "ctrl", "control"].includes(m),
        );
      return last === "insert" && mods.includes("shift");
    });
}

export function devServerLine(server: DevServerState) {
  const where = server.url ?? (server.port ? `port ${server.port}` : "");
  return `${server.name}: ${server.status}${where ? ` — ${where}` : ""}${server.command ? ` — $ ${server.command}` : ""}${server.error ? ` — ${server.error}` : ""}`;
}
