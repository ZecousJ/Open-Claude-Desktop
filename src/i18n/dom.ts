import { t as translate, subscribeLocale } from "./index";

/**
 * Translates the interface's fixed texts (labels, menus, placeholders) in
 * the document itself, so every page follows the language without each
 * component asking: a text node, or a `placeholder`, `title`, `aria-label`
 * or `alt`, whose whole English text has an entry in the current language's
 * catalog is shown in that language. The original is remembered, so English
 * comes back exactly, and a text React changes later is read as a new
 * original.
 *
 * What people wrote is never translated: the transcript (their messages and
 * the replies), text fields, code, terminals, the file viewer's content and
 * the names in its header, artifacts and
 * anything marked `data-no-translate`.
 */
/** The names a viewer shows; they are never translated, as text or as an attribute. */
const viewerNames = [
  ".file-viewer > header h2",
  ".file-viewer .artifact-title-options > span",
  ".file-viewer .code-file-tab",
  ".file-viewer .code-file-path",
];
const skip = [
  "textarea",
  "input",
  "select",
  "pre",
  "code",
  "script",
  "style",
  "svg",
  "iframe",
  "[contenteditable]",
  "[data-no-translate]",
  ".user-message",
  ".markdown",
  ".code-block",
  ".markdown-table",
  // A reply's own paragraphs; a status line under it (didn't finish,
  // reconnecting, length limit) is interface and is translated.
  ".assistant-content p:not([role=status]):not([role=status] p)",
  ".assistant-content li",
  ".assistant-content blockquote",
  ".assistant-content h1",
  ".assistant-content h2",
  ".assistant-content h3",
  ".assistant-content h4",
  ".activity-summary-text",
  // The file viewer's content and the file's or artifact's name; its
  // header's own controls (Share, Copy, Download…) are interface.
  ".file-viewer .file-preview",
  ".file-viewer .file-source",
  ".file-viewer .artifact-comment-layer",
  ...viewerNames,
  ".xterm",
  ".terminal-panel",
  ".conversation-title",
  ".row-title",
  ".history-title",
  ".routine-card-name strong",
  // Folder and file names (a folder named Developer is not 开发者).
  ".thread-folder-chip",
  ".chat-step-name",
  ".cowork-menu-text strong",
].join(",");

/**
 * In the file viewer the labels and tooltips of its controls are interface,
 * so they follow the language; what the file holds (a document's text, its
 * source, the comment layer, an image's alt) and the names above do not.
 */
const attributeSkipInViewer = [
  ".file-viewer .artifact-markdown-preview *",
  ".file-viewer .artifact-table-preview *",
  ".file-viewer .file-source *",
  ".file-viewer .artifact-comment-layer *",
  ".file-viewer img",
  ...viewerNames,
].join(",");

const attributes = [
  "placeholder",
  "title",
  "aria-label",
  "aria-valuetext",
  "alt",
];

interface Shown {
  original: string;
  shown: string;
}
const texts = new WeakMap<Node, Shown>();
const attrs = new WeakMap<Element, Map<string, Shown>>();
const tracked = new Set<WeakRef<Node>>();
const trackedElements = new Set<WeakRef<Element>>();

const skipped = (node: Node): boolean => {
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return !element || element.closest(skip) !== null;
};

/** The translation of a whole text keeping its surrounding whitespace, or undefined. */
function lookup(text: string): string | undefined {
  const key = text.trim();
  if (!key) return undefined;
  const found = translate(key);
  if (found === key) return undefined;
  return (
    text.slice(0, text.indexOf(key)) +
    found +
    text.slice(text.indexOf(key) + key.length)
  );
}

function applyText(node: Text, restoreOnly = false) {
  if (skipped(node)) return;
  const value = node.nodeValue ?? "";
  const known = texts.get(node);
  // Our own translation stands unless the language changed.
  const original = known && known.shown === value ? known.original : value;
  const next = restoreOnly ? undefined : lookup(original);
  if (next === undefined) {
    if (known) {
      if (value !== original) node.nodeValue = original;
      texts.delete(node);
    }
    return;
  }
  if (value !== next) node.nodeValue = next;
  if (!known) tracked.add(new WeakRef(node));
  texts.set(node, { original, shown: next });
}

function applyAttributes(element: Element, restoreOnly = false) {
  // Input placeholders are UI, but explicit exclusions and code are not.
  if (
    element.closest(
      "[data-no-translate],pre,code,script,style,.user-message,.markdown,.xterm,.terminal-panel",
    ) ||
    element.closest(attributeSkipInViewer)
  )
    return;
  for (const name of attributes) {
    const value = element.getAttribute(name);
    const remembered = attrs.get(element)?.get(name);
    if (value === null) {
      remembered && attrs.get(element)?.delete(name);
      continue;
    }
    const original =
      remembered && remembered.shown === value ? remembered.original : value;
    const next = restoreOnly ? undefined : lookup(original);
    if (next === undefined) {
      if (remembered) {
        if (value !== original) element.setAttribute(name, original);
        attrs.get(element)?.delete(name);
      }
      continue;
    }
    if (value !== next) element.setAttribute(name, next);
    if (!attrs.has(element)) {
      attrs.set(element, new Map());
      trackedElements.add(new WeakRef(element));
    }
    attrs.get(element)!.set(name, { original, shown: next });
  }
}

function walk(root: Node, restoreOnly = false) {
  if (root.nodeType === 3) return applyText(root as Text, restoreOnly);
  if (root.nodeType !== 1) return;
  const element = root as Element;
  if (element.closest("script,style")) return;
  applyAttributes(element, restoreOnly);
  const tree = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
  );
  for (let node = tree.nextNode(); node; node = tree.nextNode()) {
    if (node.nodeType === 3) applyText(node as Text, restoreOnly);
    else applyAttributes(node as Element, restoreOnly);
  }
}

let started = false;

/** Starts translating the document and keeps it translated as it changes. */
export function startDomTranslation() {
  if (started || typeof document === "undefined") return;
  started = true;
  const observer = new MutationObserver((records) => {
    observer.disconnect();
    try {
      for (const record of records) {
        if (record.type === "childList")
          record.addedNodes.forEach((node) => walk(node));
        else if (record.type === "characterData") walk(record.target);
        else if (record.type === "attributes" && record.target.nodeType === 1)
          applyAttributes(record.target as Element);
      }
    } finally {
      observe();
    }
  });
  const observe = () =>
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: attributes,
    });
  const all = () => {
    observer.disconnect();
    try {
      // Nodes already translated are read again (the language changed).
      for (const ref of tracked) {
        const node = ref.deref();
        if (!node || !node.isConnected) tracked.delete(ref);
        else applyText(node as Text);
      }
      for (const ref of trackedElements) {
        const element = ref.deref();
        if (!element || !element.isConnected) trackedElements.delete(ref);
        else applyAttributes(element);
      }
      walk(document.body);
    } finally {
      observe();
    }
  };
  subscribeLocale(all);
  all();
}
