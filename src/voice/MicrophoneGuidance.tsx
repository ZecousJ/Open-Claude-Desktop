import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { surface } from "../../shared/host";
import { t } from "../i18n";
import { useDismiss } from "../ui/useDismiss";
import {
  microphoneGuidance,
  microphoneReasonCopy,
  type MicrophoneReason,
} from "./microphone-guidance";
import "./microphone-guidance.css";

/** Ql. */
export function MicrophoneGuidance({
  anchor,
  platform,
  reason = "permission_denied",
  onClose,
}: {
  anchor: RefObject<HTMLElement | null>;
  platform: string;
  /** Why dictation couldn't start; permission by default. */
  reason?: MicrophoneReason;
  onClose: () => void;
}) {
  const copy = microphoneReasonCopy(reason);
  const popup = useRef<HTMLDivElement>(null);
  const title = useId(),
    description = useId();
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useDismiss([anchor, popup], true, onClose);
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      const panel = popup.current;
      if (!rect || !panel) return;
      setPosition({
        left: Math.max(
          8,
          Math.min(
            innerWidth - panel.offsetWidth - 8,
            rect.left + rect.width / 2 - panel.offsetWidth / 2,
          ),
        ),
        top: Math.max(8, rect.top - panel.offsetHeight - 8),
      });
    };
    place();
    popup.current?.focus();
    addEventListener("resize", place);
    addEventListener("scroll", place, true);
    return () => {
      removeEventListener("resize", place);
      removeEventListener("scroll", place, true);
    };
  }, [anchor]);
  const close = () => {
    onClose();
    anchor.current?.focus();
  };
  return createPortal(
    <div
      ref={popup}
      role="dialog"
      tabIndex={-1}
      aria-labelledby={title}
      aria-describedby={description}
      className="microphone-guidance"
      style={position}
    >
      <h2 id={title}>{t(copy.title)}</h2>
      <p id={description}>
        {t(
          copy.description ??
            microphoneGuidance(platform, surface === "desktop"),
        )}
      </p>
      <div>
        <button type="button" className="secondary" onClick={close}>
          {t("Got it")}
        </button>
        {reason === "permission_denied" &&
          surface === "desktop" &&
          platform === "darwin" && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                void window.desktop.openMicrophoneSettings().catch(() => {});
                close();
              }}
            >
              {t("Open System Settings")}
            </button>
          )}
      </div>
    </div>,
    document.body,
  );
}
