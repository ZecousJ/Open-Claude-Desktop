import { createPortal } from "react-dom";
import { Check } from "../ui/glyphs";
import type { WeeklyUsageStatus } from "../../shared/types";
import { currentLocale, formatText } from "../i18n";
import { Modal } from "../ui/Controls";
import "./limit-reached-dialog.css";

/**
 * The words of the limit-hit dialog for a status: the original's title by
 * window ("Weekly limit reached", "Session limit reached", else "Usage
 * limit reached"), its sentence with the reset time and day, and the quiet
 * button ("Wait until 5:00 PM", "Wait until Monday", "No, thanks").
 */
export function limitDialogText(
  status: WeeklyUsageStatus,
  locale: string = currentLocale(),
): { title: string; body: string; wait: string } {
  const reason = status.reason ?? "weekly";
  const title =
    reason === "weekly"
      ? "Weekly limit reached"
      : reason === "session"
        ? "Session limit reached"
        : "Usage limit reached";
  if (reason === "balance")
    return {
      title,
      body: formatText("You’re out of usage credits. To keep working:"),
      wait: formatText("No, thanks"),
    };
  const limitName = formatText(
    reason === "weekly" ? "weekly limit" : "plan’s limit",
  );
  const resets = new Date(status.resetsAt);
  const known =
    Number.isFinite(status.resetsAt) && status.resetsAt > Date.now();
  if (!known)
    return {
      title,
      body: formatText(
        "You’ve reached your {limitName}. To keep working before it resets:",
        { limitName },
      ),
      wait: formatText("No, thanks"),
    };
  const resetTime = resets.toLocaleTimeString(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const resetDay = resets.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
  });
  return {
    title,
    body: formatText(
      "You’ve reached your {limitName}. It resets at {resetTime} on {resetDay}. To keep working before then:",
      { limitName, resetTime, resetDay },
    ),
    wait:
      reason === "session"
        ? formatText("Wait until {resetHour}", {
            resetHour: resets.toLocaleTimeString(locale, {
              hour: "numeric",
              minute: "2-digit",
            }),
          })
        : reason === "weekly"
          ? formatText("Wait until {resetDayOfWeek}", {
              resetDayOfWeek: resets.toLocaleDateString(locale, {
                weekday: "long",
              }),
            })
          : formatText("No, thanks"),
  };
}

/**
 * The dialog's body: Add funds (the recharge entry) when the balance ran
 * out and this account can recharge, else the administrator's Get more
 * usage page; the quiet button closes it until the next limit window.
 */
export function LimitReachedBody({
  status,
  addFunds,
  onAction,
  onClose,
}: LimitReachedProps) {
  const text = limitDialogText(status);
  return (
    <>
      <p className="limit-reached-body">{text.body}</p>
      {addFunds && (
        <ul className="limit-reached-benefits">
          {[
            "Continue without interruption",
            "Pay only for what you use",
            "Track usage in real time",
          ].map((benefit) => (
            <li key={benefit}>
              <Check size={20} aria-hidden />
              <span>{benefit}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="limit-reached-actions">
        <button
          type="button"
          className="primary"
          onClick={() => {
            onClose();
            onAction();
          }}
        >
          {addFunds ? "Add funds" : "Get more usage"}
        </button>
        <button
          type="button"
          className="secondary limit-reached-wait"
          onClick={onClose}
        >
          {text.wait}
        </button>
      </div>
    </>
  );
}

interface LimitReachedProps {
  status: WeeklyUsageStatus;
  addFunds: boolean;
  onAction: () => void;
  onClose: () => void;
}

/** The limit-hit dialog, over the window. */
export function LimitReachedDialog(props: LimitReachedProps) {
  return createPortal(
    <Modal
      title={limitDialogText(props.status).title}
      onClose={props.onClose}
      className="limit-reached"
    >
      <LimitReachedBody {...props} />
    </Modal>,
    document.body,
  );
}
