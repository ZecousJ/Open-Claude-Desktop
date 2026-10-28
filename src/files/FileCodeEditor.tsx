import { useLayoutEffect, useRef } from "react";
import {
  Annotation,
  Compartment,
  EditorState,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  highlightWhitespace,
  keymap,
  lineNumbers,
  rectangularSelection,
  scrollPastEnd,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyField,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  HighlightStyle,
  bracketMatching,
  foldGutter,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { tags } from "@lezer/highlight";
import type { FilePreferences } from "./file-preferences";
import { t } from "../i18n";
import "./file-code-editor.css";

/** The reference uses CodeMirror too: O14/cc4a5adb7:530–545,
 * cbd02b8f2:1590–1670,2727–2833. No third-party source is executed. */
export interface CachedFileEditor {
  json: unknown;
  text: string;
  reload: number;
  top: number;
  left: number;
}
export type FileEditorCache = Map<string, CachedFileEditor>;
const externalChange = Annotation.define<boolean>();
const highlight = HighlightStyle.define([
  { tag: tags.keyword, class: "cm-file-keyword" },
  { tag: [tags.string, tags.regexp], class: "cm-file-string" },
  { tag: [tags.number, tags.bool, tags.null], class: "cm-file-number" },
  { tag: tags.comment, class: "cm-file-comment" },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    class: "cm-file-function",
  },
  { tag: [tags.typeName, tags.className], class: "cm-file-type" },
  { tag: [tags.propertyName, tags.attributeName], class: "cm-file-property" },
  { tag: tags.punctuation, class: "cm-file-punctuation" },
  { tag: tags.heading, class: "cm-file-heading" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
]);
function language(path: string): Extension {
  if (/\.[cm]?[jt]sx?$/i.test(path))
    return javascript({
      typescript: /\.[cm]?tsx?$/i.test(path),
      jsx: /\.[jt]sx$/i.test(path),
    });
  if (/\.(md|markdown|mdx)$/i.test(path)) return markdown();
  if (/\.(json|jsonc|ipynb)$/i.test(path)) return json();
  if (/\.(css|scss|less)$/i.test(path)) return css();
  if (/\.(html?|svg)$/i.test(path)) return html();
  return [];
}
function indentation(tabSize: number) {
  const marks = (view: EditorView) => {
    const ranges = [];
    const visited = new Set<number>();
    for (const range of view.visibleRanges) {
      let line = view.state.doc.lineAt(range.from);
      while (line.from <= range.to) {
        const leading = /^[\t ]*/.exec(line.text)![0];
        let count = 0;
        for (const c of leading)
          count += c === "\t" ? tabSize - (count % tabSize) : 1;
        if (count >= tabSize && !visited.has(line.from))
          ranges.push(
            Decoration.line({
              attributes: {
                class: "cm-file-indented",
                style: `--file-indent-width:${count}ch;--file-indent-unit:${tabSize}ch`,
              },
            }).range(line.from),
          );
        visited.add(line.from);
        if (line.number === view.state.doc.lines) break;
        line = view.state.doc.line(line.number + 1);
      }
    }
    return Decoration.set(ranges, true);
  };
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = marks(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged)
          this.decorations = marks(update.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}
function options(prefs: FilePreferences): Extension {
  return [
    EditorState.tabSize.of(prefs.tabSize),
    indentUnit.of(" ".repeat(prefs.tabSize)),
    prefs.wordWrap ? EditorView.lineWrapping : [],
    prefs.tabIndents ? keymap.of([indentWithTab]) : [],
    prefs.showWhitespace ? highlightWhitespace() : [],
    prefs.scrollPastEnd ? scrollPastEnd() : [],
    prefs.indentGuides ? indentation(prefs.tabSize) : [],
  ];
}
const themeRules = {
  "&": {
    height: "100%",
    backgroundColor: "var(--code-background, transparent)",
    color: "var(--file-editor-fg)",
  },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "inherit",
    overflow: "auto",
  },
  ".cm-content": { padding: "8px 0", caretColor: "var(--file-editor-cursor)" },
  ".cm-line": { padding: "0 12px 0 4px" },
  ".cm-gutters": {
    backgroundColor: "var(--code-background, transparent)",
    color: "var(--file-editor-muted)",
    border: "none",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 8px 0 18px",
    minWidth: "40px",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--file-editor-fg)",
  },
  ".cm-activeLine": { backgroundColor: "var(--file-editor-active-line)" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--file-editor-cursor)" },
  ".cm-selectionBackground,&.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--file-editor-selection)",
  },
  ".cm-selectionMatch": { backgroundColor: "var(--file-editor-match)" },
  ".cm-searchMatch": { backgroundColor: "var(--file-editor-match)" },
  ".cm-tooltip": {
    backgroundColor: "var(--surface-raised)",
    color: "var(--text)",
    border: "1px solid var(--border-strong)",
  },
};
const makeTheme = () =>
  EditorView.theme(themeRules, {
    dark: document.documentElement.dataset.theme !== "light",
  });

export function FileCodeEditor({
  cacheKey,
  path,
  value,
  reload,
  editable,
  preferences,
  cache,
  onChange,
  onSave,
  onEscape,
  onViewReady,
  canCache,
}: {
  cacheKey: string;
  path: string;
  value: string;
  reload: number;
  editable: boolean;
  preferences: FilePreferences;
  cache: FileEditorCache;
  onChange: (text: string) => void;
  onSave: (reason?: "blur") => void;
  onEscape: () => void;
  onViewReady?: (view: EditorView | undefined) => void;
  /** A closing/replaced tab must not reinsert its history during cleanup. */
  canCache?: () => boolean;
}) {
  const host = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | undefined>(undefined);
  const latest = useRef({
    value,
    editable,
    preferences,
    onChange,
    onSave,
    onEscape,
    onViewReady,
    canCache,
  });
  latest.current = {
    value,
    editable,
    preferences,
    onChange,
    onSave,
    onEscape,
    onViewReady,
    canCache,
  };
  const compartments = useRef({
    options: new Compartment(),
    editable: new Compartment(),
    theme: new Compartment(),
  });
  useLayoutEffect(() => {
    const node = host.current;
    if (!node) return;
    const part = compartments.current,
      initial = latest.current,
      cached = cache.get(cacheKey);
    const extensions: Extension = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      highlightActiveLine(),
      indentOnInput(),
      bracketMatching(),
      foldGutter(),
      highlightSelectionMatches(),
      syntaxHighlighting(highlight),
      language(path),
      EditorState.lineSeparator.of(
        initial.value.includes("\r\n") ? "\r\n" : "\n",
      ),
      part.options.of(options(initial.preferences)),
      part.theme.of(makeTheme()),
      part.editable.of([
        EditorState.readOnly.of(!initial.editable),
        EditorView.editable.of(initial.editable),
      ]),
      keymap.of([
        {
          key: "Mod-s",
          run: () => {
            latest.current.onSave();
            return true;
          },
        },
        {
          key: "Escape",
          run: () => {
            latest.current.onEscape();
            return true;
          },
        },
      ]),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      EditorView.contentAttributes.of({
        "aria-label": t("File contents"),
        tabindex: "0",
        "aria-multiline": "true",
        spellcheck: "false",
      }),
      EditorView.updateListener.of((update) => {
        if (
          update.docChanged &&
          !update.transactions.some((tr) => tr.annotation(externalChange))
        )
          latest.current.onChange(update.state.sliceDoc());
      }),
      EditorView.domEventHandlers({
        blur: () => {
          if (latest.current.preferences.autoSave)
            latest.current.onSave("blur");
          return false;
        },
      }),
    ];
    let state: EditorState;
    if (cached && cached.reload === reload && cached.text === initial.value) {
      try {
        state = EditorState.fromJSON(
          cached.json,
          { extensions },
          { history: historyField },
        );
      } catch {
        state = EditorState.create({ doc: initial.value, extensions });
      }
    } else state = EditorState.create({ doc: initial.value, extensions });
    const editor = new EditorView({ state, parent: node });
    view.current = editor;
    if (cached && cached.reload === reload && cached.text === initial.value) {
      editor.scrollDOM.scrollTop = cached.top;
      editor.scrollDOM.scrollLeft = cached.left;
    }
    const observer =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(() =>
            editor.dispatch({ effects: part.theme.reconfigure(makeTheme()) }),
          )
        : undefined;
    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    latest.current.onViewReady?.(editor);
    return () => {
      observer?.disconnect();
      if (latest.current.canCache?.() !== false)
        cache.set(cacheKey, {
          json: editor.state.toJSON({ history: historyField }),
          text: editor.state.sliceDoc(),
          reload,
          top: editor.scrollDOM.scrollTop,
          left: editor.scrollDOM.scrollLeft,
        });
      latest.current.onViewReady?.(undefined);
      view.current = undefined;
      editor.destroy();
    };
  }, [cacheKey, reload, path, cache]);
  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor) return;
    if (editor.state.sliceDoc() !== value)
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: value },
        annotations: externalChange.of(true),
      });
  }, [value]);
  useLayoutEffect(() => {
    view.current?.dispatch({
      effects: compartments.current.options.reconfigure(options(preferences)),
    });
  }, [preferences]);
  useLayoutEffect(() => {
    view.current?.dispatch({
      effects: compartments.current.editable.reconfigure([
        EditorState.readOnly.of(!editable),
        EditorView.editable.of(editable),
      ]),
    });
  }, [editable]);
  return (
    <div
      ref={host}
      className="file-code-editor"
      data-editable={editable || undefined}
    />
  );
}
