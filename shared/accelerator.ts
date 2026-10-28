/**
 * Keyboard shortcuts as Electron accelerators ("Control+Alt+Space",
 * "CommandOrControl+D"): read from a key press, checked, shown the way the
 * platform writes them, and matched against key presses in the page.
 */
type KeyPress = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey"
>;

const modifierKeys = new Set(["Control", "Alt", "Shift", "Meta", "OS"]);
const named: Record<string, string> = {
  " ": "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Enter: "Return",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  Tab: "Tab",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};

/** The key part of a press: letters and digits by position, then names. */
function keyName(press: KeyPress): string | undefined {
  if (/^Key[A-Z]$/.test(press.code)) return press.code.slice(3);
  if (/^Digit[0-9]$/.test(press.code)) return press.code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(press.key)) return press.key;
  if (named[press.key]) return named[press.key];
  if (/^[`\-=[\];',./\\]$/.test(press.key)) return press.key;
  return undefined;
}

/**
 * The accelerator a press makes, or undefined while only modifiers are
 * held or the press has no modifier (a bare key can't be a shortcut).
 */
export function acceleratorFromPress(
  press: KeyPress,
  platform: string,
): string | undefined {
  if (modifierKeys.has(press.key)) return undefined;
  const key = keyName(press);
  if (!key) return undefined;
  const parts: string[] = [];
  if (press.metaKey) parts.push(platform === "darwin" ? "Command" : "Super");
  if (press.ctrlKey) parts.push("Control");
  if (press.altKey) parts.push("Alt");
  if (press.shiftKey) parts.push("Shift");
  const withoutShift = parts.filter((part) => part !== "Shift");
  if (!withoutShift.length && !/^F\d+$/.test(key)) return undefined;
  return [...parts, key].join("+");
}

const acceleratorPattern =
  /^((Command|Control|CommandOrControl|Alt|Option|Shift|Super)\+)+([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Up|Down|Left|Right|Return|Escape|Backspace|Delete|Tab|Home|End|PageUp|PageDown|[`\-=[\];',./\\])$|^F([1-9]|1[0-9]|2[0-4])$/;

/** A shortcut this module could have made. */
export function validAccelerator(value: string) {
  return value.length <= 100 && acceleratorPattern.test(value);
}

/**
 * "Control+Alt+Space" as the platform writes it: macOS as symbols in the
 * system's order ⌃⌥⇧⌘ ("⌃⌥Space", "⌘D"), Windows and Linux as words in
 * theirs, Win first ("Ctrl+Alt+Space", "Win+Shift+S").
 */
export function acceleratorLabel(value: string, platform: string) {
  const mac = platform === "darwin";
  const parts = value.split("+");
  const key = parts.pop() ?? "";
  const has = (...names: string[]) => names.some((n) => parts.includes(n));
  const command =
    has("Command", "Cmd") || (mac && has("CommandOrControl", "CmdOrCtrl"));
  const control =
    has("Control", "Ctrl") || (!mac && has("CommandOrControl", "CmdOrCtrl"));
  const alt = has("Alt", "Option");
  const shift = has("Shift");
  const win = has("Super", "Meta");
  if (mac)
    return `${control ? "⌃" : ""}${alt ? "⌥" : ""}${shift ? "⇧" : ""}${command || win ? "⌘" : ""}${key}`;
  return [
    ...(win ? ["Win"] : []),
    ...(control ? ["Ctrl"] : []),
    ...(alt ? ["Alt"] : []),
    ...(shift ? ["Shift"] : []),
    key,
  ].join("+");
}

/** A press in the page matches the accelerator. */
export function pressMatches(press: KeyPress, value: string, platform: string) {
  if (!value) return false;
  const mac = platform === "darwin";
  const parts = value.split("+");
  const key = parts.pop();
  const want = {
    meta:
      parts.includes("Command") ||
      parts.includes("Super") ||
      (mac && parts.includes("CommandOrControl")),
    ctrl:
      parts.includes("Control") || (!mac && parts.includes("CommandOrControl")),
    alt: parts.includes("Alt") || parts.includes("Option"),
    shift: parts.includes("Shift"),
  };
  return (
    press.metaKey === want.meta &&
    press.ctrlKey === want.ctrl &&
    press.altKey === want.alt &&
    press.shiftKey === want.shift &&
    keyName(press) === key
  );
}

/**
 * Combinations the shortcut fields refuse because they belong to common
 * actions: Command with Q, W, H, M, comma, N, O, T, S, C or V on macOS, and
 * Control with W, N, O, T, S, C or V.
 */
export function reservedAccelerator(value: string, platform: string) {
  const parts = value.split("+");
  const key = parts.pop() ?? "";
  const only = (name: string) => parts.length === 1 && parts[0] === name;
  if (only("Control")) return key.length === 1 && "WNOTSCV".includes(key);
  return (
    platform === "darwin" &&
    only("Command") &&
    key.length === 1 &&
    "QWHMNOTSCV,".includes(key)
  );
}

/** Whether an accelerator holds Command or Control (or the Windows key, which the original calls Cmd there). */
export function hasPrimaryModifier(value: string) {
  return value
    .split("+")
    .slice(0, -1)
    .some((part) =>
      ["Command", "Control", "CommandOrControl", "Super"].includes(part),
    );
}

/**
 * Why a key press cannot be a shortcut, or undefined when it can (or when
 * only modifiers are held so far): `reserved` for a bare key or a
 * combination of common actions, `unsupported` for a key no accelerator
 * names.
 */
export function pressProblem(
  press: KeyPress,
  platform: string,
): "reserved" | "unsupported" | undefined {
  if (modifierKeys.has(press.key)) return undefined;
  if (!keyName(press)) return "unsupported";
  const accelerator = acceleratorFromPress(press, platform);
  if (!accelerator) return "reserved";
  return reservedAccelerator(accelerator, platform) ? "reserved" : undefined;
}
