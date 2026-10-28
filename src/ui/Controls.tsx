import { useConversationServices } from "../conversation/ConversationServices";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import { Copy, Check, ChevronLeft, X } from "./glyphs";
import { ReasonTooltip, useTooltip } from "./Tooltip";
import type { TooltipPlacement } from "./tooltip-position";
import { useDialogOverlay } from "./dialog-stack";
import { pushEscapeLayer } from "./useDismiss";
import { t } from "../i18n";
import { useReplyTooltipClamp } from "./useReplyTooltipClamp";
import { surface } from "../../shared/host";

export async function copyMessageText(
  copyText: (text: string, html?: string) => Promise<unknown>,
  text: string,
  rich: boolean,
) {
  const plain = text.trim();
  const html =
    rich && plain
      ? await import("./markdown-html")
          .then((module) => module.markdownToHtml(plain))
          .catch(() => undefined)
      : undefined;
  await copyText(plain, html);
}
/**
 * A square icon button whose label shows as a delayed tooltip, with the
 * shortcut when there is one. Open menus keep the tooltip hidden.
 */
export function IconButton({
  label,
  children,
  onClick,
  active = false,
  disabled = false,
  menu = false,
  expanded,
  shortcut,
  placement,
  className = "",
  tooltip: showTooltip = true,
  title,
  ref,
  name,
  pressed,
}: {
  /** The accessible name when it differs from the tooltip's text. */
  name?: string;
  /** A toggle's state, announced as pressed. */
  pressed?: boolean;
  /** The button element (a menu's anchor). */
  ref?: Ref<HTMLButtonElement>;
  label: string;
  children: ReactNode;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  active?: boolean;
  disabled?: boolean;
  menu?: boolean;
  expanded?: boolean;
  shortcut?: string[];
  placement?: TooltipPlacement;
  className?: string;
  /** False for buttons the original shows no tooltip on. */
  tooltip?: boolean;
  /** Why the button is disabled, as a tooltip (the label's is off then). */
  title?: string;
}) {
  // The document translator skips the terminal panel, so the name is put
  // through the catalog here, as the tooltip and every other label are.
  const shown = t(label);
  const { props, tooltip } = useTooltip(shown, {
    shortcut,
    placement,
    disabled: disabled || Boolean(expanded) || !showTooltip,
  });
  const button = (
    <button
      {...props}
      ref={ref}
      // Never a form's submit button (a dialog's + and remove buttons).
      type="button"
      className={`icon-button ${active ? "active" : ""} ${className}`}
      aria-label={name ? t(name) : shown}
      aria-pressed={pressed}
      aria-haspopup={menu ? "menu" : undefined}
      aria-expanded={menu ? expanded : undefined}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
  // A disabled button says why in the shared tooltip, from a focusable
  // wrapper (a disabled button takes neither focus nor, in some browsers,
  // hover), not the browser's slow native title.
  if (disabled && title)
    return (
      <ReasonTooltip reason={title} placement="above" wrap>
        {() => button}
      </ReasonTooltip>
    );
  return (
    <>
      {button}
      {tooltip}
    </>
  );
}
/** Dialog over the window. `variant="confirm"` is the short confirmation. */
export function Modal({
  title,
  titleIsUserData = false,
  titleIcon,
  children,
  onClose,
  wide = false,
  variant = "default",
  className = "",
  confirmFocus = "confirm",
  showClose = true,
  disablePointerDismissal = false,
  pending = false,
  focusDialog = false,
  dialogRole,
  back,
  subtitle,
}: {
  title: string;
  /** User-authored titles keep their literal value and label the dialog by ID. */
  titleIsUserData?: boolean;
  titleIcon?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  variant?: "default" | "confirm";
  /** A dialog's own class (Create a skill takes the window's width). */
  className?: string;
  /**
   * Which button of a confirmation starts focused: the confirming one Or the
   * first, the safe one.
   */
  confirmFocus?: "confirm" | "cancel";
  showClose?: boolean;
  disablePointerDismissal?: boolean;
  /**
   * What the dialog confirmed is still under way: Escape and a press on the
   * backdrop are ignored until it ends.
   */
  pending?: boolean;
  focusDialog?: boolean;
  dialogRole?: "dialog" | "alertdialog";
  /** A back button before the title, for a dialog showing a sub-view. */
  back?: { label: string; onClick: () => void };
  /** A line under the title row, before the body. */
  subtitle?: ReactNode;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const isPending = useRef(pending);
  useLayoutEffect(() => {
    close.current = onClose;
    isPending.current = pending;
  }, [onClose, pending]);
  // Closing fades it out (unmounted, it is put back for the exit), and one
  // opened over another dialog blurs that one instead of shading twice.
  const overlay = useDialogOverlay();
  // Taken while rendering, before an autoFocus field inside takes focus.
  const [previous] = useState(() =>
    typeof document === "undefined"
      ? null
      : (document.activeElement as HTMLElement | null),
  );
  useEffect(() => {
    const dialog = ref.current;
    // A confirmation starts on its confirming button, as R-1289 shows;
    // other dialogs on their first field (the header's Close button comes
    // first in the document), unless a field already took focus.
    const first = focusDialog
      ? dialog
      : variant === "confirm"
        ? dialog?.querySelector<HTMLElement>(
            confirmFocus === "cancel"
              ? ".button-row > button:first-child"
              : ".button-row > button:last-child",
          )
        : dialog?.contains(document.activeElement)
          ? null
          : (dialog?.querySelector<HTMLElement>(
              "input:not(:disabled),textarea:not(:disabled),select:not(:disabled)",
            ) ?? dialog?.querySelector<HTMLElement>("button:not(:disabled)"));
    first?.focus();
    // The confirmation's starting button shows its ring however the dialog
    // was opened (the original's data-initial-focus, 00-foundation.css).
    if (variant === "confirm") first?.setAttribute("data-initial-focus", "");
    // A menu or popover opened inside the dialog takes Escape first.
    const layer = pushEscapeLayer();
    const listener = (e: KeyboardEvent) => {
      const ownOverlay = overlay.ref.current;
      if (!ownOverlay || ownOverlay.hasAttribute("data-nested-open")) return;
      if (e.key === "Escape") {
        if (!layer.isInnermost()) return;
        // Only this dialog closes, not one it opened over (Settings).
        e.stopPropagation();
        if (!isPending.current) close.current();
      }
      if (e.key === "Tab") {
        const items = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]',
          ) ?? [],
        );
        if (!items.length) return;
        if (e.shiftKey && document.activeElement === items[0]) {
          e.preventDefault();
          items.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === items.at(-1)) {
          e.preventDefault();
          items[0].focus();
        }
      }
    };
    document.addEventListener("keydown", listener);
    return () => {
      document.removeEventListener("keydown", listener);
      layer.release();
      previous?.focus();
    };
  }, []);
  return (
    <div
      {...overlay}
      className="overlay"
      onMouseDown={(e) => {
        if (
          !disablePointerDismissal &&
          !pending &&
          e.target === e.currentTarget
        )
          onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal u-scroll-fade-y ${wide ? "wide" : ""} ${variant === "confirm" ? "confirm" : ""} ${className}`}
        role={dialogRole ?? (variant === "confirm" ? "alertdialog" : "dialog")}
        aria-modal="true"
        aria-label={titleIsUserData ? undefined : title}
        aria-labelledby={titleIsUserData ? titleId : undefined}
        tabIndex={focusDialog ? -1 : undefined}
      >
        <header>
          {back ? (
            <div className="modal-back-title">
              <IconButton
                label={back.label}
                tooltip={false}
                onClick={back.onClick}
              >
                <ChevronLeft size={18} />
              </IconButton>
              <h2
                id={titleIsUserData ? titleId : undefined}
                data-no-translate={titleIsUserData || undefined}
              >
                {title}
              </h2>
            </div>
          ) : titleIcon ? (
            <div className="modal-title-with-icon">
              {titleIcon}
              <h2
                id={titleIsUserData ? titleId : undefined}
                data-no-translate={titleIsUserData || undefined}
              >
                {title}
              </h2>
            </div>
          ) : (
            <h2
              id={titleIsUserData ? titleId : undefined}
              data-no-translate={titleIsUserData || undefined}
            >
              {title}
            </h2>
          )}
          {variant !== "confirm" && showClose && (
            // No tooltip, as the original's dialog Close, like Sheet's.
            <IconButton label="Close" tooltip={false} onClick={onClose}>
              {/* The web's dialogs close with a 20px X. */}
              <X size={surface === "web" ? 20 : 18} />
            </IconButton>
          )}
        </header>
        {subtitle && <div className="modal-subtitle">{subtitle}</div>}
        {children}
      </div>
    </div>
  );
}
export function CopyButton({
  text,
  iconOnly = false,
  glyph,
  message,
  rich,
  codeBlock = false,
}: {
  text: string;
  iconOnly?: boolean;
  glyph?: ReactNode;
  /**
   * The text is a message: copied without the blank space round it and, for
   * a reply (`"reply"`), also as rich text, so a paste into a document or mail
   * keeps its headings, lists and code (the original's copy action: desktop
   * bundle 2.31226.1 writes text/plain and text/html, trimmed).
   */
  message?: "reply" | "prompt";
  /**
   * Also write the text as rich text (Markdown rendered to HTML). On by default
   * for a reply; a Chat prompt turns it on too, as the reference design copies
   * a sent prompt the same way.
   */
  rich?: boolean;
  codeBlock?: boolean;
}) {
  const services = useConversationServices();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const [tooltip, setTooltip] = useState(false);
  const tooltipId = useId();
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const operation = useRef(0);
  useEffect(
    () => () => {
      operation.current++;
      clearTimeout(hoverTimer.current);
      clearTimeout(resetTimer.current);
    },
    [],
  );
  function hideTooltip() {
    clearTimeout(hoverTimer.current);
    setTooltip(false);
  }
  function showTooltip() {
    clearTimeout(hoverTimer.current);
    if (!copied) hoverTimer.current = setTimeout(() => setTooltip(true), 300);
  }
  async function copy() {
    const current = ++operation.current;
    hideTooltip();
    clearTimeout(resetTimer.current);
    setFailed(false);
    try {
      const plain = message ? text.trim() : text;
      // The rich form is a nicety: without it the plain text still copies.
      const html =
        (rich ?? message === "reply") && plain
          ? await import("./markdown-html")
              .then((module) => module.markdownToHtml(plain))
              .catch(() => undefined)
          : undefined;
      if (current !== operation.current) return;
      await services.copyText(plain, html);
      if (current !== operation.current) return;
      setCopied(true);
    } catch {
      if (current !== operation.current) return;
      setCopied(false);
      setFailed(true);
      setTooltip(true);
    }
    // Reference reply-copy-001: the check occupies about two seconds.
    resetTimer.current = setTimeout(() => {
      setCopied(false);
      setFailed(false);
      setTooltip(false);
    }, 2000);
  }
  // The document translator skips code blocks (.markdown), so the words are
  // translated here.
  const label = failed ? t("Copy failed") : copied ? t("Copied") : t("Copy");
  const tipText = failed ? t("Copy failed") : t("Copy");
  const tip = useReplyTooltipClamp(iconOnly && tooltip, tipText);
  return (
    <button
      className={`small-action ${iconOnly ? "icon-only" : ""}`}
      title={iconOnly ? undefined : label}
      aria-label={codeBlock ? t("Copy to clipboard") : label}
      data-testid={codeBlock ? "code-block-copy" : undefined}
      aria-describedby={iconOnly && tooltip ? tooltipId : undefined}
      onPointerEnter={iconOnly ? showTooltip : undefined}
      onPointerLeave={hideTooltip}
      onFocus={iconOnly ? showTooltip : undefined}
      onBlur={hideTooltip}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          hideTooltip();
          event.stopPropagation();
        }
      }}
      onClick={() => void copy()}
    >
      {copied ? <Check size={14} /> : (glyph ?? <Copy size={14} />)}
      {!iconOnly && <span>{label}</span>}
      {iconOnly && (
        <span
          ref={tip}
          id={tooltipId}
          role="tooltip"
          className="copy-tooltip"
          data-open={tooltip}
        >
          {tipText}
        </span>
      )}
      <span className="copy-status" role="status">
        {copied ? t("Copied") : failed ? t("Copy failed") : ""}
      </span>
    </button>
  );
}
