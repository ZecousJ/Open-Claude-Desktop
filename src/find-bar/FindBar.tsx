import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AppIcon } from "../ui/app-icon";
import { formatText, t } from "../i18n";
import {
  findable,
  findDebounceMs,
  matchLabel,
  type FindBarBridge,
  type FindResult,
} from "../../shared/find-in-page";

const mac = /Mac/.test(navigator.userAgent);
const keys = mac
  ? { next: "⌘G", previous: "⇧⌘G" }
  : { next: "Ctrl+G", previous: "Ctrl+Shift+G" };

/**
 * The find bar (shared/find-in-page.ts): a field that searches the window's
 * page 250ms after typing rests, the match count ("3/12"), previous and next,
 * and close. Enter steps to the next match and Shift+Enter to the previous one,
 * as do the Down and Up arrows; Escape closes the bar. As in the original, a
 * query needs three characters, or one Chinese, Japanese or Korean character.
 */
export function FindBar({ bridge }: { bridge: FindBarBridge }) {
  const field = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<FindResult | null>(null);
  // Only the answer to the latest request counts.
  const request = useRef(0);
  const latest = useRef(query);
  latest.current = query;
  const ask = (text: string, forward: boolean, findNext: boolean) => {
    const id = ++request.current;
    void bridge
      .find(text, { forward, findNext })
      .then((answer) => id === request.current && setResult(answer))
      .catch(() => id === request.current && setResult(null));
  };
  useEffect(() => {
    if (!findable(query)) {
      request.current++;
      setResult(null);
      void bridge.stop().catch(() => {});
      return;
    }
    setResult(null);
    const timer = setTimeout(() => ask(query, true, true), findDebounceMs);
    return () => clearTimeout(timer);
  }, [query]);
  const step = (forward: boolean) => {
    if (findable(latest.current)) ask(latest.current, forward, false);
  };
  const close = () => void bridge.close().catch(() => {});
  useEffect(() => {
    const offFocus = bridge.onFocus(() => {
      field.current?.focus();
      field.current?.select();
    });
    const offStep = bridge.onStep(step);
    const offClear = bridge.onClear(() => {
      request.current++;
      setQuery("");
      setResult(null);
    });
    field.current?.focus();
    return () => {
      offFocus();
      offStep();
      offClear();
    };
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const forward =
      event.key === "Enter"
        ? !event.shiftKey
        : event.key === "ArrowDown"
          ? true
          : event.key === "ArrowUp"
            ? false
            : undefined;
    if (forward !== undefined) {
      event.preventDefault();
      step(forward);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };
  const label = matchLabel(query, result);
  const stepless = !label || !result?.total;
  return (
    <div
      className="find-bar"
      role="search"
      onMouseDown={(event) => {
        // A click anywhere but the buttons puts the cursor in the field.
        if (!(event.target as Element).closest("button, input")) {
          event.preventDefault();
          field.current?.focus();
        }
      }}
    >
      <label className="find-field">
        <input
          ref={field}
          type="text"
          spellCheck={false}
          autoComplete="off"
          aria-label={t("Find in page")}
          placeholder={t("Find in page")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <span className="find-count" role="status">
          {label}
        </span>
      </label>
      <span className="find-divider" aria-hidden="true" />
      <div className="find-buttons">
        <button
          type="button"
          aria-label={t("Previous match")}
          title={formatText("Previous match ({shortcut})", {
            shortcut: keys.previous,
          })}
          disabled={stepless}
          onClick={() => step(false)}
        >
          <AppIcon name="ArrowUp" />
        </button>
        <button
          type="button"
          aria-label={t("Next match")}
          title={formatText("Next match ({shortcut})", {
            shortcut: keys.next,
          })}
          disabled={stepless}
          onClick={() => step(true)}
        >
          <AppIcon name="ArrowDown" />
        </button>
        <button
          type="button"
          className="find-close"
          aria-label={t("Close find bar")}
          title={t("Close find bar (Esc)")}
          onClick={close}
        >
          <AppIcon name="XBase" />
        </button>
      </div>
    </div>
  );
}
