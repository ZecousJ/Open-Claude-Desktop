import {
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type TextareaHTMLAttributes,
} from "react";
import { DOMSerializer, Slice } from "prosemirror-model";
import { EditorView, type NodeView } from "prosemirror-view";
import { EditorState } from "prosemirror-state";
import { undo } from "prosemirror-history";
import { AppContext } from "../app/AppContext";
import { useAddMenuResource } from "./useAddMenuResource";
import {
  callableSkills,
  editSkillTokens,
  type SkillToken,
} from "./skill-tokens";
import type { ComposerField } from "./composer-field";
import type { ChatInputHandoff } from "./chat-input-handoff";
import {
  chatDoc,
  chatDraft,
  positionToRaw,
  rawSelection,
  rawToPosition,
} from "./atomic-chat-model";
import {
  applyChatTransaction,
  createChatState,
  replaceChatDoc,
} from "./atomic-chat-state";
import { AtomicSkillCard } from "./AtomicSkillCard";
import "prosemirror-view/style/prosemirror.css";
import "./skill-token-mirror.css";
import "./atomic-chat-input.css";

export interface AtomicChatInputProps {
  identity: string;
  scope?: object;
  field: RefObject<ComposerField | null>;
  text: string;
  tokens: SkillToken[];
  nativeProps: TextareaHTMLAttributes<HTMLTextAreaElement>;
  onDraft(text: string, tokens: SkillToken[]): void;
  onSelection(caret: number): void;
  onError(error: unknown): void;
  handoff?: ChatInputHandoff;
}
const readSkills = (bridge: Window["desktop"]) => bridge.customizeSkills();

/** The keyboard/attachment policy predates the editor. Its callbacks read
 * this small event surface and the explicit ComposerField DOM contract. */
function policyEvent(event: Event, field: ComposerField) {
  const keyboard = event as KeyboardEvent,
    clipboard = event as ClipboardEvent;
  return {
    nativeEvent: event,
    currentTarget: field,
    target: event.target,
    key: keyboard.key,
    code: keyboard.code,
    keyCode: keyboard.keyCode,
    repeat: keyboard.repeat,
    shiftKey: keyboard.shiftKey,
    altKey: keyboard.altKey,
    ctrlKey: keyboard.ctrlKey,
    metaKey: keyboard.metaKey,
    clipboardData: clipboard.clipboardData,
    get defaultPrevented() {
      return event.defaultPrevented;
    },
    preventDefault: () => event.preventDefault(),
    stopPropagation: () => event.stopPropagation(),
    isDefaultPrevented: () => event.defaultPrevented,
    isPropagationStopped: () => event.cancelBubble,
    persist() {},
  };
}

/** ProseMirror owns composition, native selection, clipboard and history.
 * React owns only the surrounding draft and the source-backed readonly card. */
export function AtomicChatInput(props: AtomicChatInputProps) {
  const app = useContext(AppContext);
  const bridge = window.desktop;
  const inventory = useAddMenuResource(readSkills, app?.accountId ?? "local");
  const skills = callableSkills(inventory.rows);
  const current = useRef({ props, skills });
  current.current = { props, skills };
  const element = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | undefined>(undefined);
  const nodes = useRef(new Set<{ refresh(): void }>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [card, setCard] = useState<{
    anchor: HTMLElement;
    name: string;
    description: string;
  }>();
  const cancel = useCallback(() => clearTimeout(timer.current), []);
  const close = useCallback(() => {
    cancel();
    setCard(undefined);
  }, [cancel]);
  const leave = useCallback(() => {
    cancel();
    timer.current = setTimeout(() => setCard(undefined), 50);
  }, [cancel]);
  const dictation = useRef<EditorState | undefined>(undefined);
  const lease = useRef<symbol | undefined>(undefined);
  const active = useRef(false);
  const sync = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const dom = element.current;
    if (!dom) return;
    const started = props;
    setCard(undefined);
    cancel();
    const owner = Symbol("chat-editor");
    lease.current = owner;
    active.current = true;
    const valid = () =>
      active.current &&
      lease.current === owner &&
      current.current.props.identity === started.identity &&
      current.current.props.scope === started.scope &&
      window.desktop === bridge;
    const callable = () =>
      new Set(current.current.skills.map((skill) => skill.name));
    let state = createChatState(props.text, props.tokens, callable);
    if (props.handoff) {
      const { entries, index } = props.handoff;
      const initial = entries[0]!;
      state = createChatState(initial.text, initial.skillTokens, callable);
      for (const entry of entries.slice(1))
        state = applyChatTransaction(
          state,
          replaceChatDoc(
            state,
            chatDoc(state.schema, entry.text, entry.skillTokens),
          ),
        ).state;
      for (let at = entries.length - 1; at > index; at--)
        undo(state, (transaction) => {
          state = state.apply(transaction);
        });
      state = state.apply(
        state.tr.setSelection(
          rawSelection(
            state.doc,
            props.handoff.start,
            props.handoff.end,
            props.handoff.direction,
          ),
        ),
      );
    }
    // The properties below install the explicit field contract on this DOM
    // element. It remains a div/contenteditable, never a hidden textarea.
    const field = dom as unknown as ComposerField;
    const keys = [
      "value",
      "selectionStart",
      "selectionEnd",
      "selectionDirection",
      "disabled",
      "readOnly",
      "setSelectionRange",
      "setRangeText",
      "insertText",
      "resizeToContent",
    ];
    const previous = new Map(
      keys.map((key) => [key, Object.getOwnPropertyDescriptor(field, key)]),
    );
    let view!: EditorView;
    const resize = () => {
      if (!valid()) return;
      field.style.height = "auto";
      const height = Math.min(field.scrollHeight, 370);
      const home = field.closest<HTMLElement>(".chat-home");
      const value = `${Math.max(0, height - 22)}px`;
      if (home && home.style.getPropertyValue("--composer-grow") !== value)
        home.style.setProperty("--composer-grow", value);
    };
    const selection = () => {
      const value = view.state.selection;
      return {
        start: positionToRaw(view.state.doc, value.from, -1),
        end: positionToRaw(view.state.doc, value.to, 1),
        direction:
          value.anchor > value.head ? ("backward" as const) : ("none" as const),
      };
    };
    const select = (start: number, end = start, direction = "none") => {
      if (!valid()) return;
      const length = chatDraft(view.state.doc).text.length;
      start = Math.max(0, Math.min(length, start));
      end = Math.max(start, Math.min(length, end));
      view.dispatch(
        view.state.tr.setSelection(
          rawSelection(view.state.doc, start, end, direction),
        ),
      );
    };
    const replace = (
      text: string,
      start = selection().start,
      end = selection().end,
      mode = "end",
    ) => {
      if (!valid() || field.disabled || field.readOnly) return;
      const transaction = view.state.tr.insertText(
        text,
        rawToPosition(view.state.doc, start, -1),
        rawToPosition(view.state.doc, end, 1),
      );
      const nextStart =
        mode === "start" || mode === "select" ? start : start + text.length;
      transaction.setSelection(
        rawSelection(
          transaction.doc,
          nextStart,
          mode === "select" ? start + text.length : nextStart,
        ),
      );
      view.dispatch(transaction.scrollIntoView());
    };
    const nodeView = (node: import("prosemirror-model").Node): NodeView => {
      const chip = dom.ownerDocument.createElement("span");
      chip.className = "composer-atomic-skill";
      chip.setAttribute("contenteditable", "false");
      chip.dataset.skillToken = String(node.attrs.name);
      chip.setAttribute("data-no-translate", "true");
      const label = dom.ownerDocument.createElement("span");
      label.className = "composer-atomic-label";
      const prefix = dom.ownerDocument.createElement("span");
      prefix.className = "composer-skill-prefix";
      prefix.setAttribute("aria-hidden", "true");
      prefix.textContent = "/";
      const name = dom.ownerDocument.createElement("span");
      name.className = "composer-skill-name";
      label.append(prefix, name);
      chip.append(label);
      const item = () =>
        current.current.skills.find((skill) => skill.name === node.attrs.name);
      const refresh = () => {
        const known = item();
        chip.dataset.callable = String(Boolean(known));
        chip.setAttribute(
          "aria-label",
          known ? `/${node.attrs.name}` : `$${node.attrs.name}`,
        );
        name.textContent = known
          ? String(node.attrs.name)
          : `$${node.attrs.name}`;
        prefix.style.display = known ? "" : "none";
        if (known) {
          chip.setAttribute("role", "button");
          chip.setAttribute("aria-haspopup", "dialog");
          chip.tabIndex = -1;
        } else {
          chip.removeAttribute("role");
          chip.removeAttribute("aria-haspopup");
          chip.removeAttribute("tabindex");
        }
      };
      const show = (immediate: boolean) => {
        const skill = item();
        if (!skill || !valid()) return;
        cancel();
        const open = () =>
          setCard({
            anchor: chip,
            name: skill.name,
            description: skill.description,
          });
        if (immediate) open();
        else timer.current = setTimeout(open, 50);
      };
      const enter = () => show(false),
        click = () => show(true);
      chip.addEventListener("mouseenter", enter);
      chip.addEventListener("mouseleave", leave);
      chip.addEventListener("click", click);
      const adapter = { refresh };
      nodes.current.add(adapter);
      refresh();
      return {
        dom: chip,
        selectNode() {
          chip.dataset.selected = "true";
        },
        deselectNode() {
          delete chip.dataset.selected;
        },
        ignoreMutation: () => true,
        stopEvent: (event) =>
          ["click", "mouseenter", "mouseleave"].includes(event.type),
        destroy() {
          nodes.current.delete(adapter);
          chip.removeEventListener("mouseenter", enter);
          chip.removeEventListener("mouseleave", leave);
          chip.removeEventListener("click", click);
        },
      };
    };
    view = new EditorView(
      { mount: dom },
      {
        state,
        nodeViews: { skill: nodeView },
        editable: () =>
          !current.current.props.nativeProps.disabled &&
          !current.current.props.nativeProps.readOnly,
        attributes: () => ({
          role: "textbox",
          "aria-multiline": "true",
          "data-no-translate": "true",
          tabindex: current.current.props.nativeProps.disabled ? "-1" : "0",
        }),
        clipboardSerializer: DOMSerializer.fromSchema(state.schema),
        clipboardTextSerializer: (slice) =>
          slice.content.textBetween(0, slice.content.size, "\n", (node) =>
            node.type.name === "skill" ? `$${node.attrs.name}` : "\n",
          ),
        handlePaste(_view, event, slice) {
          const data = event.clipboardData;
          if (!valid() || !data) return false;
          const text = data.getData("text/plain").replace(/\r\n?/g, "\n");
          if (!text) return true;
          let reference = false;
          slice.content.descendants((node) => {
            if (node.type.name === "skill") reference = true;
          });
          const parsed = slice.content.textBetween(
            0,
            slice.content.size,
            "\n",
            (node) =>
              node.type.name === "skill" ? `$${node.attrs.name}` : "\n",
          );
          // Self-copied atoms may retain their identity. Ordinary HTML keeps
          // the original textarea's exact plain-text whitespace/line breaks;
          // HTML cannot introduce a command absent from the plain clipboard.
          if (reference && parsed === text) return false;
          const doc = chatDoc(view.state.schema, text, []);
          view.dispatch(
            view.state.tr
              .replaceSelection(new Slice(doc.content, 1, 1))
              .scrollIntoView()
              .setMeta("paste", true)
              .setMeta("uiEvent", "paste"),
          );
          return true;
        },
        handleKeyDown(_view, event) {
          if (
            !valid() ||
            view.composing ||
            event.isComposing ||
            event.keyCode === 229
          )
            return false;
          current.current.props.nativeProps.onKeyDown?.(
            policyEvent(
              event,
              field,
            ) as unknown as React.KeyboardEvent<HTMLTextAreaElement>,
          );
          return event.defaultPrevented;
        },
        handleDOMEvents: {
          // Returning true here retires PM's keyboard handling without
          // preventDefault: the platform IME keeps its native Backspace/Enter.
          // A key-level guard alone would still let later keymap plugins run.
          keydown(_view, event) {
            return view.composing || event.isComposing || event.keyCode === 229;
          },
          paste(_view, event) {
            if (!valid()) return false;
            current.current.props.nativeProps.onPaste?.(
              policyEvent(
                event,
                field,
              ) as unknown as React.ClipboardEvent<HTMLTextAreaElement>,
            );
            return event.defaultPrevented;
          },
          focus(_view, event) {
            current.current.props.nativeProps.onFocus?.(
              policyEvent(
                event,
                field,
              ) as unknown as React.FocusEvent<HTMLTextAreaElement>,
            );
            return false;
          },
          blur(_view, event) {
            current.current.props.nativeProps.onBlur?.(
              policyEvent(
                event,
                field,
              ) as unknown as React.FocusEvent<HTMLTextAreaElement>,
            );
            return false;
          },
        },
        dispatchTransaction(transaction) {
          if (!valid()) return;
          const next = applyChatTransaction(view.state, transaction);
          view.updateState(next.state);
          resize();
          const draft = chatDraft(next.state.doc);
          field.dataset.empty = String(!draft.text);
          current.current.props.onSelection(selection().end);
          if (next.transactions.some((entry) => entry.docChanged))
            current.current.props.onDraft(draft.text, draft.skillTokens);
        },
      },
    );
    editor.current = view;
    Object.defineProperties(field, {
      value: {
        configurable: true,
        get: () => chatDraft(view.state.doc).text,
        set(value: string) {
          const before = chatDraft(view.state.doc);
          view.dispatch(
            replaceChatDoc(
              view.state,
              chatDoc(
                view.state.schema,
                value,
                editSkillTokens(before.text, value, before.skillTokens),
              ),
            ),
          );
        },
      },
      selectionStart: {
        configurable: true,
        get: () => selection().start,
        set: (start: number) => select(start, Math.max(start, selection().end)),
      },
      selectionEnd: {
        configurable: true,
        get: () => selection().end,
        set: (end: number) => select(Math.min(end, selection().start), end),
      },
      selectionDirection: {
        configurable: true,
        get: () => selection().direction,
      },
      disabled: {
        configurable: true,
        get: () => Boolean(current.current.props.nativeProps.disabled),
      },
      readOnly: {
        configurable: true,
        get: () => Boolean(current.current.props.nativeProps.readOnly),
      },
    });
    field.setSelectionRange = select;
    field.setRangeText = replace;
    field.insertText = (text) => replace(text);
    field.resizeToContent = resize;
    // Keep the real DOM focus method intact. ProseMirror's own focus event
    // listener owns DOM selection; overriding view.dom.focus recurses through
    // focusPreventScroll, especially when StrictMode reuses this same div.
    props.field.current = field;
    field.dataset.empty = String(!chatDraft(view.state.doc).text);
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(resize);
    observer?.observe(field);
    window.addEventListener("resize", resize);
    resize();
    if (props.handoff?.focused) field.focus({ preventScroll: true });
    return () => {
      if (lease.current === owner) {
        active.current = false;
        cancel();
        dictation.current = undefined;
      }
      if (props.field.current === field) props.field.current = null;
      editor.current = undefined;
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      view.destroy();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(field, key, descriptor);
        else Reflect.deleteProperty(field, key);
      }
    };
  }, [props.identity, props.scope, bridge]);
  sync.current = () => {
    const view = editor.current;
    if (!view || view.composing) return;
    const next = current.current.props;
    const doc = chatDoc(view.state.schema, next.text, next.tokens);
    const spoken = Boolean(next.nativeProps.readOnly);
    if (spoken && !dictation.current) dictation.current = view.state;
    if (!spoken && dictation.current) {
      const before = dictation.current;
      dictation.current = undefined;
      view.updateState(before);
    }
    const before = chatDraft(view.state.doc);
    if (
      before.text !== next.text ||
      JSON.stringify(before.skillTokens) !== JSON.stringify(next.tokens)
    )
      view.updateState(
        applyChatTransaction(
          view.state,
          replaceChatDoc(view.state, doc, !spoken),
        ).state,
      );
    view.setProps({
      editable: () => !next.nativeProps.disabled && !next.nativeProps.readOnly,
    });
    if (element.current) element.current.dataset.empty = String(!next.text);
    props.field.current?.resizeToContent?.();
  };
  useLayoutEffect(() => {
    sync.current();
  });
  useLayoutEffect(() => {
    for (const node of nodes.current) node.refresh();
    if (card && !skills.some((skill) => skill.name === card.name)) close();
  }, [inventory.rows]);
  return (
    <>
      <div
        ref={element}
        className="composer-atomic-input"
        aria-label={props.nativeProps["aria-label"]}
        aria-disabled={props.nativeProps.disabled || undefined}
        aria-readonly={props.nativeProps.readOnly || undefined}
        data-placeholder={props.nativeProps.placeholder}
        data-previewing={
          props.nativeProps[
            "data-previewing" as keyof typeof props.nativeProps
          ] || undefined
        }
      />
      {card && (
        <AtomicSkillCard
          {...card}
          onClose={close}
          onEnter={cancel}
          onLeave={leave}
        />
      )}
    </>
  );
}
