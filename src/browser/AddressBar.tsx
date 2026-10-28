import { useEffect, useRef, useState, type RefObject } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  MousePointer,
  RotateCw,
} from "../ui/glyphs";
import { Spinner } from "../ui/Spinner";
import type { BrowserTabState } from "../../shared/browser";
import { displayAddress } from "../../shared/browser";
import { WithTooltip } from "../ui/Tooltip";
import { t } from "../i18n";

/**
 * The address split for the resting field: the host (with "http://" for
 * an insecure page) in the primary colour and the rest muted. Undefined
 * for an address that is not a web page (a file path shows whole).
 */
export function addressParts(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return undefined;
    const host = `${parsed.protocol === "http:" ? "http://" : ""}${parsed.host}`;
    const shown = displayAddress(url);
    return { host, suffix: shown.slice(host.length) };
  } catch {
    return undefined;
  }
}

/**
 * The card's second row: Back, Forward, Reload (a spinner while loading), the
 * address field ("Type a URL") and, on the right, Select element (the viewport
 * is in the ⋮ menu, as the original's Viewport). At rest the field shows the
 * host and, muted, the path, centred; focused, the text slides left over 150ms
 * and becomes the whole URL to edit. Enter opens what is typed unless an input
 * method is composing (What's new), Escape puts the page's address back.
 */
export function AddressBar({
  tab,
  picking,
  canPick,
  inputRef,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onPick,
  sketching = false,
  onEndSketch,
  onOpenExternal,
}: {
  tab?: BrowserTabState;
  picking: boolean;
  /** Select element needs a page and somewhere to put the element. */
  canPick: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
  /** Opens what was typed; resolves false when it was refused (the field stays). */
  onNavigate: (text: string) => Promise<boolean>;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onStop: () => void;
  onPick: () => void;
  /** Sketch mode is on: the button reads Annotate (⇧⌘X) and ends it. */
  sketching?: boolean;
  onEndSketch?: () => void;
  onOpenExternal?: () => void;
}) {
  const url = tab?.url ?? "";
  const [text, setText] = useState(displayAddress(url));
  const [editing, setEditing] = useState(false);
  const own = useRef<HTMLInputElement>(null);
  const field = inputRef ?? own;
  // A new page's address replaces the text unless the person is typing.
  useEffect(() => {
    if (!editing) setText(displayAddress(url));
  }, [url, editing]);
  const loading = Boolean(tab?.loading);
  const shown = displayAddress(url);
  const parts = addressParts(url);
  return (
    <div className="browser-address-row">
      <button
        className="browser-icon-button browser-nav"
        aria-label="Back"
        title="Back"
        disabled={!tab?.canGoBack}
        onClick={onBack}
      >
        <ArrowLeft size={16} strokeWidth={1.6} />
      </button>
      <button
        className="browser-icon-button browser-nav"
        aria-label="Forward"
        title="Forward"
        disabled={!tab?.canGoForward}
        onClick={onForward}
      >
        <ArrowRight size={16} strokeWidth={1.6} />
      </button>
      <div className="browser-address-shell">
        {loading ? (
          <span
            className="browser-loading-status"
            role="status"
            aria-label={t("Loading page")}
          >
            <Spinner size="sm" />
          </span>
        ) : (
          <button
            className="browser-icon-button browser-nav"
            aria-label="Reload"
            title="Reload"
            disabled={!loading && !url && !tab?.error}
            onClick={onReload}
          >
            <RotateCw size={15} strokeWidth={1.6} />
          </button>
        )}
        <div
          className="browser-address-field"
          data-overlay={shown ? "" : undefined}
        >
          <input
            ref={field}
            className="browser-address"
            aria-label={t("Page URL")}
            placeholder="Type a URL"
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            value={text}
            onFocus={(event) => {
              setEditing(true);
              if (url && url !== "about:blank") setText(url);
              const input = event.currentTarget;
              requestAnimationFrame(() => input.select());
            }}
            onBlur={() => setEditing(false)}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              // An input method's Enter or Escape belongs to the composition.
              if (event.nativeEvent.isComposing || event.keyCode === 229)
                return;
              if (event.key === "Enter") {
                event.preventDefault();
                const input = event.currentTarget;
                void onNavigate(text).then((opened) => {
                  if (opened) input.blur();
                });
              } else if (event.key === "Escape") {
                event.preventDefault();
                setText(displayAddress(url));
                event.currentTarget.blur();
              }
            }}
          />
          {shown && (
            <span className="browser-address-overlay" aria-hidden="true">
              <span className="browser-address-spacer" />
              {parts ? (
                <span className="browser-address-text">
                  <span>{parts.host}</span>
                  {parts.suffix && (
                    <span className="browser-address-path">{parts.suffix}</span>
                  )}
                </span>
              ) : (
                <span className="browser-address-text">{shown}</span>
              )}
              <span className="browser-address-spacer browser-address-spacer-end" />
            </span>
          )}
        </div>
        {onOpenExternal && (
          <button
            className="browser-icon-button"
            aria-label={t("Open in default browser")}
            title={t("Open in default browser")}
            onClick={onOpenExternal}
          >
            <ExternalLink size={16} />
          </button>
        )}
      </div>
      {/* Select element says what it sends; while picking it becomes Exit
         selection mode, and in sketch mode it reads Annotate with ⇧⌘X and ends
         the sketch. */}
      <WithTooltip
        label={
          sketching
            ? "Annotate"
            : picking
              ? "Exit selection mode"
              : "Select element"
        }
        shortcut={sketching ? ["shift", "mod", "X"] : ["shift", "mod", "S"]}
        detail={
          picking || sketching
            ? undefined
            : "Sends Claudex a screenshot plus the element’s HTML, styles, selector and any React component details."
        }
        size="wrap"
        placement="below"
        disabled={!canPick && !picking && !sketching}
      >
        {(tip) => (
          <button
            {...tip}
            className={`browser-icon-button browser-tool${picking || sketching ? " on" : ""}`}
            aria-label={sketching ? "Annotate" : "Select element"}
            aria-pressed={picking || sketching}
            disabled={!canPick && !picking && !sketching}
            onClick={sketching ? onEndSketch : onPick}
          >
            <MousePointer size={15} strokeWidth={1.5} />
          </button>
        )}
      </WithTooltip>
    </div>
  );
}
