const ringSize = 500;

export const maxScreenshotSide = 1568;

export const maxScreenshotBytes = 1.5 * 1024 * 1024;

export const commandTimeoutMs = 15_000;

/** The roles `read_page` with the interactive filter keeps. */
const interactiveRoles = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "treeitem",
  "textarea",
]);

/** Roles that only group others: their children are shown in their place. */
const transparentRoles = new Set([
  "none",
  "generic",
  "presentation",
  "InlineTextBox",
  "LineBreak",
  "ignored",
]);

/** Query parameters that look like secrets are hidden from the network log. */
export function redactUrl(url: string) {
  try {
    const parsed = new URL(url);
    let changed = false;
    for (const key of [...parsed.searchParams.keys()])
      if (/token|key|secret|pass|auth|session|sig|code|credential/i.test(key)) {
        parsed.searchParams.set(key, "REDACTED");
        changed = true;
      }
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      changed = true;
    }
    return changed ? parsed.href : url;
  } catch {
    return url;
  }
}

/** Keeps the last `size` entries. */
export class Ring<T> {
  private items: T[] = [];
  constructor(private size = ringSize) {}
  push(item: T) {
    this.items.push(item);
    if (this.items.length > this.size)
      this.items.splice(0, this.items.length - this.size);
  }
  values() {
    return [...this.items];
  }
  find(predicate: (item: T) => boolean) {
    for (let i = this.items.length - 1; i >= 0; i--)
      if (predicate(this.items[i])) return this.items[i];
    return undefined;
  }
  clear() {
    this.items = [];
  }
}

interface KeyDescription {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  modifiers: number;
  commands?: string[];
}

export const namedKeys: Record<
  string,
  [key: string, code: string, keyCode: number, text?: string]
> = {
  enter: ["Enter", "Enter", 13, "\r"],
  return: ["Enter", "Enter", 13, "\r"],
  tab: ["Tab", "Tab", 9],
  backspace: ["Backspace", "Backspace", 8],
  delete: ["Delete", "Delete", 46],
  escape: ["Escape", "Escape", 27],
  esc: ["Escape", "Escape", 27],
  space: [" ", "Space", 32, " "],
  arrowup: ["ArrowUp", "ArrowUp", 38],
  up: ["ArrowUp", "ArrowUp", 38],
  arrowdown: ["ArrowDown", "ArrowDown", 40],
  down: ["ArrowDown", "ArrowDown", 40],
  arrowleft: ["ArrowLeft", "ArrowLeft", 37],
  left: ["ArrowLeft", "ArrowLeft", 37],
  arrowright: ["ArrowRight", "ArrowRight", 39],
  right: ["ArrowRight", "ArrowRight", 39],
  home: ["Home", "Home", 36],
  end: ["End", "End", 35],
  pageup: ["PageUp", "PageUp", 33],
  pagedown: ["PageDown", "PageDown", 34],
};
for (let n = 1; n <= 12; n++) namedKeys[`f${n}`] = [`F${n}`, `F${n}`, 111 + n];

/** macOS editing commands for ⌘ shortcuts (CDP key events do not run them on their own). */
const macCommands: Record<string, string> = {
  a: "selectAll",
  c: "copy",
  v: "paste",
  x: "cut",
  z: "undo",
};

/**
 * One key or chord ("Enter", "cmd+a", "ctrl+shift+Tab") as CDP key event
 * fields. Modifiers: alt/option 1, ctrl/control 2, cmd/meta/command 4,
 * shift 8. Throws for a name it does not know.
 */
export function describeKey(
  combo: string,
  platform = "darwin",
): KeyDescription {
  const parts = combo.split("+").map((part) => part.trim());
  const name = parts.pop() ?? "";
  if (!name) throw new Error(`"${combo}" is not a key.`);
  let modifiers = 0;
  for (const raw of parts) {
    const modifier = raw.toLowerCase();
    if (modifier === "alt" || modifier === "option") modifiers |= 1;
    else if (modifier === "ctrl" || modifier === "control") modifiers |= 2;
    else if (
      modifier === "cmd" ||
      modifier === "meta" ||
      modifier === "command" ||
      modifier === "super"
    )
      modifiers |= 4;
    else if (modifier === "shift") modifiers |= 8;
    else throw new Error(`"${raw}" is not a modifier key.`);
  }
  const named = namedKeys[name.toLowerCase()];
  if (named) {
    const [key, code, keyCode, text] = named;
    return {
      key,
      code,
      keyCode,
      modifiers,
      ...(text && !(modifiers & 6) ? { text } : {}),
    };
  }
  if ([...name].length !== 1) throw new Error(`"${name}" is not a key.`);
  const lower = name.toLowerCase();
  const upper = name.toUpperCase();
  const code = /[a-z]/.test(lower)
    ? `Key${upper}`
    : /[0-9]/.test(name)
      ? `Digit${name}`
      : "";
  const shifted = modifiers & 8 && /[a-z]/.test(lower) ? upper : name;
  const commandKey = platform === "darwin" ? 4 : 2;
  const command = modifiers === commandKey ? macCommands[lower] : undefined;
  return {
    key: shifted,
    code,
    keyCode: /[a-z0-9]/i.test(name) ? upper.charCodeAt(0) : name.charCodeAt(0),
    modifiers,
    ...(modifiers & 6 ? {} : { text: shifted }),
    ...(command && platform === "darwin" ? { commands: [command] } : {}),
  };
}

interface AXValue {
  value?: unknown;
}

export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: { name: string; value: AXValue }[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

/**
 * The accessibility tree as indented lines, each element that can be
 * targeted tagged `[ref_N]`. `refFor` gives (and remembers) the ref of a
 * DOM node, so refs stay the same across snapshots of one document.
 */
export function formatAXTree(
  nodes: readonly AXNode[],
  refFor: (backendNodeId: number) => string,
  options: {
    interactiveOnly?: boolean;
    maxChars?: number;
    rootBackendId?: number;
  } = {},
) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  let roots = nodes.filter(
    (node) => !node.parentId || !byId.has(node.parentId),
  );
  if (options.rootBackendId !== undefined) {
    const root = nodes.find(
      (node) => node.backendDOMNodeId === options.rootBackendId,
    );
    if (root) roots = [root];
  }
  const maxChars = options.maxChars ?? 50_000;
  const lines: string[] = [];
  let length = 0;
  let truncated = false;
  const add = (line: string) => {
    if (length + line.length + 1 > maxChars) {
      truncated = true;
      return false;
    }
    lines.push(line);
    length += line.length + 1;
    return true;
  };
  const text = (value: AXValue | undefined) =>
    value?.value === undefined || value.value === null
      ? ""
      : String(value.value).replace(/\s+/g, " ").trim();
  const walk = (node: AXNode, depth: number): void => {
    if (truncated) return;
    const role = text(node.role);
    const name = text(node.name);
    const children = (node.childIds ?? [])
      .map((id) => byId.get(id))
      .filter((child): child is AXNode => !!child);
    const transparent =
      node.ignored || transparentRoles.has(role) || (!role && !name);
    const isText = role === "StaticText" || role === "text";
    let shown = !transparent;
    if (shown && options.interactiveOnly) shown = interactiveRoles.has(role);
    if (isText) {
      if (!options.interactiveOnly && name)
        add(`${"  ".repeat(depth)}- text ${JSON.stringify(clip(name, 300))}`);
      return;
    }
    if (shown) {
      const ref =
        node.backendDOMNodeId !== undefined
          ? ` [${refFor(node.backendDOMNodeId)}]`
          : "";
      const value = text(node.value);
      const states = (node.properties ?? [])
        .filter(
          (p) =>
            [
              "checked",
              "selected",
              "expanded",
              "disabled",
              "pressed",
              "focused",
            ].includes(p.name) &&
            p.value?.value !== false &&
            p.value?.value !== "false",
        )
        .map((p) =>
          p.value?.value === true || p.value?.value === "true"
            ? p.name
            : `${p.name}=${String(p.value?.value)}`,
        );
      const line =
        `${"  ".repeat(depth)}- ${role}` +
        (name ? ` ${JSON.stringify(clip(name, 200))}` : "") +
        ref +
        (value ? ` value=${JSON.stringify(clip(value, 200))}` : "") +
        (states.length ? ` (${states.join(", ")})` : "");
      if (!add(line)) return;
    }
    for (const child of children) walk(child, shown ? depth + 1 : depth);
  };
  for (const root of roots) walk(root, 0);
  if (truncated)
    lines.push("… (the page is longer; read a part of it with a ref)");
  return lines.join("\n");
}

export function clip(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Page functions run on an element (`this`); results come back as JSON values. */
export const elementDetails = `function () {
  const el = this;
  const esc = (v) => (window.CSS && CSS.escape ? CSS.escape(v) : v);
  const path = (e) => {
    const parts = [];
    for (let n = e; n && n.nodeType === 1 && parts.length < 8; n = n.parentElement) {
      if (n.id) { parts.unshift("#" + esc(n.id)); break; }
      let part = n.tagName.toLowerCase();
      const parent = n.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === n.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(n) + 1) + ")";
      }
      parts.unshift(part);
    }
    return parts.join(" > ");
  };
  const keys = ["display","position","box-sizing","width","height","margin","padding","border","border-radius","color","background-color","background-image","font-family","font-size","font-weight","line-height","letter-spacing","text-align","text-decoration","opacity","box-shadow","gap","flex-direction","justify-content","align-items","grid-template-columns","overflow","z-index","cursor","transform"];
  const cs = getComputedStyle(el);
  const styles = {};
  for (const k of keys) styles[k] = cs.getPropertyValue(k);
  const r = el.getBoundingClientRect();
  return {
    selector: path(el),
    tag: el.tagName.toLowerCase(),
    text: ((el.innerText || el.textContent || "") + "").trim().slice(0, 500),
    outerHTML: el.outerHTML.slice(0, 4096),
    styles,
    box: { x: r.x, y: r.y, width: r.width, height: r.height },
  };
}`;

export const setFieldValue = `function (value) {
  const el = this;
  const text = String(value);
  if (el instanceof HTMLSelectElement) {
    const option = [...el.options].find((o) => o.value === text || o.text.trim() === text);
    if (!option) throw new Error("The list has no option " + JSON.stringify(text) + ".");
    el.value = option.value;
  } else if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    el.checked = value === true || text === "true";
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, text); else el.value = text;
  } else if (el.isContentEditable) {
    el.textContent = text;
  } else {
    throw new Error("That element is not a form field.");
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}`;

export const fieldKindScript = `function () {
  const el = this;
  return {
    tag: el.tagName ? el.tagName.toLowerCase() : "",
    type: el instanceof HTMLInputElement ? el.type : "",
    password: el instanceof HTMLInputElement && el.type === "password",
  };
}`;

export const pageText = `(() => {
  const el = document.querySelector("main, [role=main], article") || document.body;
  return el ? el.innerText : "";
})()`;

/** An iPhone's user agent for the Mobile viewport. */
export const mobileUserAgent =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/** An iPad's user agent for the Tablet viewport. */
export const tabletUserAgent =
  "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
