import {
  cloneElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import type { AtomicChatInputProps } from "./AtomicChatInput";
import { handoffDraft } from "./chat-input-handoff";
import { createPieceStore, errorStateOf } from "../app/chunk-recovery";
import { ChunkErrorView } from "../ui/lazy-piece";

type Module = typeof import("./AtomicChatInput");

/** Native input remains usable during a cold editor chunk. Handoff waits
 * for IME completion and transfers the actual accepted text and selection. */
export function createChatInput(loader: () => Promise<Module>) {
  const store = createPieceStore<Module>(loader, (module) =>
    module &&
    typeof module === "object" &&
    "AtomicChatInput" in module &&
    typeof module.AtomicChatInput === "function"
      ? (module as Module)
      : undefined,
  );
  return function ChatInput(
    props: AtomicChatInputProps & { fallback: ReactElement },
  ) {
    const status = useSyncExternalStore(
      store.subscribe,
      store.snapshot,
      store.snapshot,
    );
    const runtime = store.loaded();
    const [composing, setComposing] = useState(false);
    const composingNow = useRef(false);
    const established = useRef(false),
      dictating = useRef(false);
    const handoff = useMemo(
      () => handoffDraft({ text: props.text, skillTokens: props.tokens }),
      [props.identity, props.scope],
    );
    const area = useRef<HTMLTextAreaElement | null>(null);
    useEffect(() => {
      store.start();
    }, []);
    if (!established.current) {
      if (props.nativeProps.readOnly && !dictating.current) {
        dictating.current = true;
        handoff.beginGroup();
      }
      handoff.accept({ text: props.text, skillTokens: props.tokens });
      if (!props.nativeProps.readOnly && dictating.current) {
        handoff.endGroup();
        dictating.current = false;
      }
    }
    if (status.phase === "declined") throw status.error;
    if (
      runtime &&
      (established.current ||
        (!composingNow.current && !props.nativeProps.readOnly))
    ) {
      established.current = true;
      const field = area.current;
      if (field) {
        handoff.state.start = field.selectionStart;
        handoff.state.end = field.selectionEnd;
        handoff.state.direction = field.selectionDirection;
        handoff.state.focused = field.ownerDocument.activeElement === field;
      }
      return <runtime.AtomicChatInput {...props} handoff={handoff.state} />;
    }
    const fallback = props.fallback as ReactElement<
      React.TextareaHTMLAttributes<HTMLTextAreaElement>
    >;
    const native = cloneElement(fallback, {
      ref: (node: HTMLTextAreaElement | null) => {
        const old = area.current;
        area.current = node;
        if (node) props.field.current = node;
        else if (props.field.current === old) props.field.current = null;
      },
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => {
        handoff.typed(
          event.currentTarget.value,
          (event.nativeEvent as InputEvent).inputType ?? "",
        );
        fallback.props.onChange?.(event);
      },
      onCompositionStart: (
        event: React.CompositionEvent<HTMLTextAreaElement>,
      ) => {
        handoff.beginGroup();
        composingNow.current = true;
        setComposing(true);
        fallback.props.onCompositionStart?.(event);
      },
      onCompositionEnd: (
        event: React.CompositionEvent<HTMLTextAreaElement>,
      ) => {
        fallback.props.onCompositionEnd?.(event);
        // React's final input/change follows compositionend in the same task.
        queueMicrotask(() => {
          handoff.endGroup();
          composingNow.current = false;
          setComposing(false);
        });
      },
    } as React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
      ref(node: HTMLTextAreaElement | null): void;
    });
    const failure = errorStateOf(status);
    return (
      <>
        {native}
        {failure && (
          <ChunkErrorView
            state={failure}
            busy={status.phase === "reloading"}
            onRetry={store.retry}
            onReload={store.reload}
          />
        )}
      </>
    );
  };
}
export const ChatInput = createChatInput(() => import("./AtomicChatInput"));
