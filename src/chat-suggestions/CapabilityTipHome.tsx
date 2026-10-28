import { useEffect, useRef, useState } from "react";
import { X } from "../ui/glyphs";
import { useApp } from "../app/AppContext";
import { useT } from "../i18n";
import { emptyTipPacing } from "../../shared/chat-suggestions";
import { capabilityTipCopy } from "./capability-tip-copy";
import { actOnCapabilityTip } from "./tip-actions";
import { useTipAvailability } from "./useTipAvailability";
import {
  initialTipRotation,
  rememberTipRotation,
  tipRotationMs,
} from "./tip-rotation";
import "./chat-suggestions.css";
import "./capability-tip-home.css";

// mn/hn line layout.
export default function CapabilityTipHome() {
  const app = useApp();
  const t = useT();
  const tips = useTipAvailability();
  const key = app.accountId ?? "local";
  const [rotation, setRotation] = useState(() =>
    initialTipRotation(key, tips.length, Date.now()),
  );
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const held = hovered || focused;
  const [visible, setVisible] = useState(true);
  const timing = useRef({
    rotation,
    due: rotation.shownAt + tipRotationMs,
    pausedAt: undefined as number | undefined,
    held: false,
  });
  const tip = tips[rotation.index % Math.max(tips.length, 1)];
  useEffect(() => {
    const change = () => setVisible(document.visibilityState !== "hidden");
    change();
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  useEffect(() => {
    if (tips.length < 2) return;
    const now = Date.now();
    const clock = timing.current;
    if (clock.rotation !== rotation) {
      clock.rotation = rotation;
      clock.due = rotation.shownAt + tipRotationMs;
    }
    if (!visible && clock.pausedAt === undefined) clock.pausedAt = now;
    if (held) clock.held = true;
    if (held || !visible) return;
    if (clock.pausedAt !== undefined) {
      clock.due += now - clock.pausedAt;
      clock.pausedAt = undefined;
    }
    if (clock.held) {
      clock.held = false;
      clock.due = Math.max(clock.due, now + tipRotationMs);
    }
    rememberTipRotation(key, {
      index: rotation.index,
      shownAt: clock.due - tipRotationMs,
    });
    let fade: number | undefined;
    const advance = () => {
      const next = {
        index: (rotation.index + 1) % tips.length,
        shownAt: Date.now(),
      };
      rememberTipRotation(key, next);
      setRotation(next);
      setLeaving(false);
    };
    const timer = window.setTimeout(
      () => {
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches)
          advance();
        else {
          setLeaving(true);
          fade = window.setTimeout(() => {
            fade = undefined;
            advance();
          }, 60);
        }
      },
      Math.max(0, clock.due - now),
    );
    return () => {
      window.clearTimeout(timer);
      if (fade !== undefined) {
        window.clearTimeout(fade);
        advance();
      }
    };
  }, [tips.length, rotation, held, visible, key]);
  if (!tip) return null;
  const hasAction = tip !== "file_uploads" && tip !== "screenshots";
  return (
    <div className="capability-tip-home" data-testid="capability-tip-home">
      <span className="capability-tip-home-prefix">{t("Tip:")}</span>{" "}
      <span
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setFocused(false);
          }
        }}
      >
        <span
          className={`capability-tip-home-words${leaving ? " leaving" : ""}`}
        >
          {t(capabilityTipCopy[tip].body)}
        </span>{" "}
        <span className="capability-tip-home-actions">
          {hasAction && (
            <button
              className="capability-tip-home-action"
              onClick={() => actOnCapabilityTip(app, tip)}
            >
              {t(capabilityTipCopy[tip].action!)}
            </button>
          )}
          <button
            className="capability-tip-home-dismiss"
            aria-label={t("Dismiss tip")}
            onClick={() => {
              const state =
                app.snapshot.settings.capabilityTipState ?? emptyTipPacing();
              void app
                .updatePreference({
                  capabilityTipState: {
                    ...state,
                    dismissed: [...new Set([...state.dismissed, tip])],
                  },
                })
                .catch(app.report);
            }}
          >
            <X size={12} />
          </button>
        </span>
      </span>
    </div>
  );
}
