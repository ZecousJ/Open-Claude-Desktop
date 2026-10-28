import { CircleAlert, TriangleAlert } from "lucide-react";
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
 * The corner notices (src/ui/toast-store.ts), stacked as the original's toaster
 * draws them: the newest in front at the bottom, each older one 14px higher and
 * 4% smaller from its bottom edge, cut to the front one's height with its text
 * hidden. A toast rises from below as it fades in, and shrinks to 85% as it
 * fades out, over 200ms. Escape inside one dismisses it.
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
              toast.variant === "danger" ? (
                <CircleAlert size={20} strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <TriangleAlert
                  size={20}
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
              )
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
