import type {
  ComputerUseContent,
  ComputerUseTier,
  ComputerUseToolResult,
} from "../../shared/computer-use";

export const defaultMaxActionsPerTurn = 200;

export const maxTypedText = 2000;

/** Keys that act on the whole system or other apps; never pressed for the model. */
const blockedKeyList = [
  "super+q",
  "alt+super+escape",
  "ctrl+super+q",
  "shift+super+q",
  "alt+shift+super+q",
  "super+tab",
  "shift+super+tab",
  "super+space",
  "super+h",
  "alt+super+h",
  "ctrl+alt+delete",
  "super+l",
  "alt+tab",
  "alt+shift+tab",
  "alt+f4",
  "super",
  "super+r",
  "super+x",
  "super+d",
  "ctrl+shift+escape",
];

const modifierAliases: Record<string, string> = {
  cmd: "super",
  command: "super",
  meta: "super",
  super: "super",
  win: "super",
  windows: "super",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
};

const keyAliases: Record<string, string> = { esc: "escape", del: "delete" };

/** A key combination in a comparable form: sorted modifiers, then the key. */
export function normalizeKey(key: string) {
  const parts = key
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const modifiers = new Set<string>();
  const keys: string[] = [];
  for (const part of parts)
    if (modifierAliases[part]) modifiers.add(modifierAliases[part]);
    else keys.push(keyAliases[part] ?? part);
  return [...[...modifiers].sort(), ...keys].join("+");
}

const blockedKeys = new Set(blockedKeyList.map(normalizeKey));

export const keyBlocked = (key: string) => blockedKeys.has(normalizeKey(key));

export const text = (value: string): ComputerUseContent => ({
  type: "text",
  text: value,
});

export const failure = (message: string): ComputerUseToolResult => ({
  content: [text(message)],
  isError: true,
});

/** A refusal the model reads: why, and what to do instead. */
export class Refusal extends Error {}

/** What each tool needs, besides a granted app. */
export const actionTier: Record<string, ComputerUseTier | undefined> = {
  open_application: "read",
  screenshot: "read",
  get_app_state: "read",
  click: "click",
  scroll: "click",
  type_text: "full",
  press_key: "full",
  set_value: "full",
  drag: "full",
  perform_secondary_action: "full",
};

export const tierRank: Record<ComputerUseTier, number> = {
  read: 0,
  click: 1,
  full: 2,
};

/** A short label for the activity notice ("Clicked in Notes"). */
export const actionLabels: Record<string, string> = {
  open_application: "Opening",
  screenshot: "Looking at",
  get_app_state: "Looking at",
  click: "Clicking in",
  scroll: "Scrolling in",
  type_text: "Typing in",
  press_key: "Pressing keys in",
  set_value: "Editing",
  drag: "Dragging in",
  perform_secondary_action: "Using",
};

export const str = (value: unknown, name: string, max = 500): string => {
  if (typeof value !== "string" || !value.trim())
    throw new Refusal(`${name} is required.`);
  if (value.length > max) throw new Refusal(`${name} is too long.`);
  return value;
};

export const num = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Refusal(`${name} must be a number.`);
  return value;
};

export const optionalIndex = (value: unknown) => {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isInteger(value))
    return String(value);
  if (typeof value === "string" && /^\d{1,6}$/.test(value.trim()))
    return value.trim();
  throw new Refusal("element_index must be an index from get_app_state.");
};
