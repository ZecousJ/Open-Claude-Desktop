import { useContext, useEffect, useId, useRef, useState } from "react";
import type { Conversation } from "../../shared/types";
import { AppContext } from "../app/AppContext";
import { formatText, t } from "../i18n";
import { AppIcon } from "../ui/app-icon";
import "./computer-link.css";

type Status = "connected" | "away" | "signedOut" | undefined;

function linkStatus(c: Conversation): Status {
  if (c.linkedComputerOnline === true && c.linkedComputerAccess !== false)
    return "connected";
  if (c.linkedComputerAccess === false && c.linkedComputerOnline !== false)
    return "signedOut";
  if (c.linkedComputerOnline === false) return "away";
  return undefined;
}

/**
 * The computer a chat is linked to, beside its title. Resting on it opens a
 * 280px card after 150ms: the computer's name, its status line (a green dot and
 * "Connected" with what that allows, an amber dot and "Asleep or app closed",
 * or plain "Linked" while unknown), a rule and Manage devices. The button
 * carries the status dot when there is one.
 */
export function ComputerLinkIndicator({
  conversation: c,
}: {
  conversation: Conversation;
}) {
  const app = useContext(AppContext);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      wrap.current?.querySelector<HTMLButtonElement>("button")?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  if (!c.linkedToComputer) return null;
  const status = linkStatus(c);
  const name = c.linkedComputerName || t("Linked to another computer");
  const line =
    status === "connected"
      ? {
          dot: "connected",
          text: t("Connected"),
          detail: t("Claudex can use the files and apps on your computer."),
        }
      : status === "away"
        ? { dot: "away", text: t("Asleep or app closed") }
        : status === "signedOut"
          ? {
              dot: "away",
              text: t("Sign in again to access local files on your computer."),
            }
          : { text: t("Linked") };
  const label =
    status === undefined
      ? name
      : formatText("{name}, {status}", {
          name,
          status:
            status === "connected"
              ? t("Connected")
              : status === "away"
                ? t("Asleep or app closed")
                : line.text,
        });
  const show = (delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 100);
  };
  return (
    <span
      className="computer-link"
      ref={wrap}
      onPointerEnter={() => show(150)}
      onPointerLeave={hide}
      onFocus={() => show(0)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          hide();
      }}
    >
      <button
        type="button"
        className="computer-link-trigger"
        aria-label={label}
        aria-expanded={open}
        data-status={line.dot ? status : undefined}
      >
        <AppIcon name="Laptop" size={20} />
        {line.dot && (
          <span
            className={`computer-link-dot ${line.dot}`}
            aria-hidden="true"
          />
        )}
      </button>
      {open && (
        <div
          className="computer-link-card"
          role="group"
          aria-labelledby={titleId}
        >
          <div className="computer-link-card-body">
            <div className="computer-link-card-head">
              <span
                id={titleId}
                className="computer-link-name"
                data-no-translate
              >
                {name}
              </span>
              <span className="computer-link-status">
                {line.dot && (
                  <span
                    className={`computer-link-dot ${line.dot}`}
                    aria-hidden="true"
                  />
                )}
                <span>
                  {line.text}
                  {line.detail && (
                    <span className="computer-link-detail">{line.detail}</span>
                  )}
                </span>
              </span>
            </div>
            <div className="computer-link-rule" aria-hidden="true" />
            <button
              type="button"
              className="computer-link-manage"
              onClick={() => {
                setOpen(false);
                app?.openSettingsTab("cowork");
              }}
            >
              {t("Manage devices")}
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
