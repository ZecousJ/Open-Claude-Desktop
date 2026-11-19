import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { InfoCircleIcon } from "../policy/policy-icons";
import { CloseSmallIcon } from "./icons";
import { useNoticeStack } from "./notice-stack";
import {
  dismissToast,
  pauseToasts,
  useToasts,
  type Toast,
} from "./toast-store";

/** Warning, md (live claude.ai bundle, 2026-10-14, shared-frame-B1JORnF0 icon font). */
/** Anthropicon WarningCircle at 20px (the live icon font, opsz 20, wght 400). */
const warningCirclePath =
  "M17.56 10Q17.56 11.5 16.99 12.89Q16.42 14.28 15.34 15.34Q14.28 16.42 12.89 16.99Q11.5 17.56 10 17.56Q8.5 17.56 7.11 16.99Q5.72 16.42 4.66 15.34Q3.58 14.28 3.01 12.89Q2.44 11.5 2.44 10Q2.44 8.5 3.01 7.11Q3.58 5.72 4.66 4.66Q5.72 3.58 7.11 3.01Q8.5 2.44 10 2.44Q11.5 2.44 12.89 3.01Q14.28 3.58 15.34 4.66Q16.42 5.72 16.99 7.11Q17.56 8.5 17.56 10ZM16.44 10Q16.44 8.72 15.95 7.54Q15.46 6.36 14.56 5.44Q13.64 4.54 12.46 4.05Q11.28 3.56 10 3.56Q8.72 3.56 7.54 4.05Q6.36 4.54 5.44 5.44Q4.54 6.36 4.05 7.54Q3.56 8.72 3.56 10Q3.56 11.28 4.05 12.46Q4.54 13.64 5.44 14.56Q6.36 15.46 7.54 15.95Q8.72 16.44 10 16.44Q11.28 16.44 12.46 15.95Q13.64 15.46 14.56 14.56Q15.46 13.64 15.95 12.46Q16.44 11.28 16.44 10ZM9.04 6.66Q9.02 6.4 9.18 6.22Q9.34 6.04 9.6 6.04H10.4Q10.66 6.04 10.82 6.22Q10.98 6.4 10.96 6.66L10.56 10.46Q10.54 10.72 10.37 10.84Q10.2 10.96 10 10.96Q9.8 10.96 9.63 10.84Q9.46 10.72 9.44 10.46ZM9.94 11.94Q10.16 11.92 10.34 12.08Q10.52 12.24 10.52 12.46Q10.54 12.7 10.39 12.87Q10.24 13.04 10 13.06L10.06 13L10 12.94L9.94 13L10 13.06Q10.22 13.08 10.4 12.92Q10.58 12.76 10.6 12.54L10.56 13.04Q10.54 13.26 10.37 13.42Q10.2 13.58 9.96 13.56Q9.74 13.54 9.58 13.37Q9.42 13.2 9.44 12.96L9.48 12.46Q9.48 12.24 9.66 12.08Q9.84 11.92 10.06 11.94Q10.48 11.96 10.77 12.27Q11.06 12.58 11.06 13Q11.06 13.44 10.75 13.75Q10.44 14.06 10 14.06Q9.56 14.06 9.25 13.75Q8.94 13.44 8.94 13Q8.94 12.58 9.23 12.27Q9.52 11.96 9.94 11.94Z";
const warningPath =
  "m9.8 7.52q.04-.26.24-.4q.19-.14.44-.12q.26.04.4.24q.14.19.12.44l-.4 2.8q-.04.26-.22.39q-.17.13-.38.13q-.21 0-.38-.13q-.18-.13-.22-.39l-.4-2.8q-.04-.27.14-.48q.18-.2.46-.2h.78q.26 0 .43.17q.17.17.17.43q0 .26-.17.43q-.17.17-.43.17h-.78q.28 0 .46-.2q.18-.21.14-.48l.4 2.8q-.04-.26-.22-.39q-.17-.13-.38-.13q-.21 0-.38.13q-.18.13-.22.39zm.14 4.38q.23-.02.42.15q.2.17.2.41q.02.25-.14.43q-.16.19-.42.21l.1-.1l-.1-.1l-.1.1l.1.1q.23.02.42-.15q.2-.17.22-.41l-.04.5q-.02.24-.21.41q-.18.17-.43.15q-.24-.02-.41-.2q-.17-.19-.15-.44l.04-.5q0-.24.19-.41q.2-.17.43-.15q.44.02.74.34q.3.32.3.76q0 .46-.32.78q-.32.32-.78.32q-.46 0-.78-.32q-.32-.32-.32-.78q0-.44.3-.76q.3-.32.74-.34zm5.32 5.2h-10.5q-.79 0-1.44-.39q-.65-.38-1.03-1.03q-.39-.65-.39-1.42v-.12q0-.81.43-1.5l5.32-8.52q.36-.57.95-.89q.59-.33 1.26-.33h.28q.67 0 1.26.33q.59.32.95.89l5.32 8.52q.43.69.43 1.5v.12q0 .77-.39 1.42q-.38.65-1.03 1.03q-.65.39-1.42.39zm0-1.2q.45 0 .82-.22q.37-.23.6-.6q.22-.37.22-.82v-.12q0-.47-.25-.86l-5.32-8.52q-.41-.66-1.19-.66h-.28q-.78 0-1.19.66l-5.32 8.52q-.25.39-.25.86v.12q0 .45.22.82q.23.37.6.6q.37.22.84.22z";

export function ToastMessage({ toast }: { toast: Toast }) {
  const action = toast.inlineAction;
  const index = action ? toast.message.indexOf(action.label) : -1;
  if (!action || index < 0) return <>{toast.message}</>;
  return (
    <>
      {toast.message.slice(0, index)}
      <button
        type="button"
        className="toast-inline-link"
        title={action.title}
        aria-label={action.ariaLabel}
        onClick={action.onSelect}
      >
        {action.label}
      </button>
      {toast.message.slice(index + action.label.length)}
    </>
  );
}

/**
 * The corner notices (src/ui/toast-store.ts), stacked as the original's
 * toaster draws them (desktop bundle 2.31226.1): the newest in front at the
 * bottom, each older one 14px higher and 4% smaller from its bottom edge,
 * cut to the front one's height with its text hidden. A toast rises from
 * below as it fades in, and shrinks to 85% as it fades out, over 200ms.
 * Escape inside one dismisses it.
 */
export function Toaster() {
  const toasts = useToasts();
  const stack = useRef<HTMLElement>(null);
  const front = toasts.find((toast) => !toast.closing);
  // The stack takes the front toast's height; the ones behind match it.
  useLayoutEffect(() => {
    const box = stack.current;
    const element = box?.querySelector<HTMLElement>(
      '.toast[data-front="true"]',
    );
    if (!box || !element) return;
    const measure = () =>
      box.style.setProperty(
        "--toast-front-height",
        `${element.getBoundingClientRect().height}px`,
      );
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(element);
    return () => watch.disconnect();
  }, [front?.id]);
  // It shares the corner with the other notices.
  useNoticeStack(stack, toasts.length > 0);
  // The stack going away releases a held countdown.
  useLayoutEffect(() => () => pauseToasts(false), []);
  if (!toasts.length) return null;
  let behind = 0;
  return (
    <section
      ref={stack}
      className="toast-stack"
      aria-label="Notifications"
      onPointerEnter={() => pauseToasts(true)}
      onPointerLeave={() => pauseToasts(false)}
    >
      {toasts.map((toast) => {
        // Closing toasts keep their place; the others count from the front.
        const index = toast.closing ? behind : behind++;
        const isFront = toast === front;
        const action = toast.action && (
          <button
            type="button"
            className="toast-action"
            onClick={() => {
              toast.action?.onSelect();
              dismissToast(toast.id);
            }}
          >
            {toast.action.label}
          </button>
        );
        return (
          <div
            key={toast.id}
            className="toast"
            role="status"
            data-state={toast.closing ? "closed" : "open"}
            data-front={isFront}
            data-action={toast.action ? true : undefined}
            data-variant={toast.variant}
            data-behind={!isFront && !toast.closing ? true : undefined}
            data-limited={toast.limited || undefined}
            inert={toast.limited || undefined}
            aria-hidden={toast.limited || undefined}
            style={
              {
                "--toast-index": index,
                zIndex: toasts.length - index,
              } as CSSProperties
            }
            onKeyDown={(event) => {
              if (event.key === "Escape") dismissToast(toast.id, true);
            }}
          >
            {toast.variant ? (
              <svg
                width={20}
                height={20}
                viewBox="0 0 20 20"
                fill="currentColor"
                aria-hidden="true"
              >
                <path
                  d={
                    toast.variant === "danger" ? warningCirclePath : warningPath
                  }
                />
              </svg>
            ) : (
              <InfoCircleIcon size={20} />
            )}
            <span className="toast-text">
              <span className={toast.variant ? "toast-title" : undefined}>
                <ToastMessage toast={toast} />
              </span>
              {toast.description && (
                <span className="toast-description">{toast.description}</span>
              )}
              {toast.count > 1 && (
                <span className="toast-count"> (×{toast.count})</span>
              )}
              {action}
            </span>
            <button
              type="button"
              className="toast-close"
              aria-label="Dismiss"
              onClick={() => dismissToast(toast.id, true)}
            >
              <CloseSmallIcon />
            </button>
          </div>
        );
      })}
    </section>
  );
}
