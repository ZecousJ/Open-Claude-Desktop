import { useId, useState } from "react";
import {
  acceleratorFromPress,
  acceleratorLabel,
  pressProblem,
} from "../../shared/accelerator";
import { formatText } from "../i18n";

/** What a refused shortcut says. */
export const shortcutProblems = {
  reserved:
    "This shortcut is reserved for common actions. Try a different combination.",
  unsupported:
    "This shortcut combination isn’t supported. Try a different combination.",
  taken:
    "This shortcut is already in use by another app. Try a different combination.",
};

/**
 * Why the system refused a recorded shortcut: another app holds it (the desktop
 * integration's registration error), else it isn't supported.
 */
export function refusedShortcut(error: unknown): keyof typeof shortcutProblems {
  const message = error instanceof Error ? error.message : String(error);
  return /used by another app/.test(message) ? "taken" : "unsupported";
}

/**
 * A shortcut field: the shortcut centred in a 30px box, "Set shortcut" while
 * there is none, and a clear button at its right end. While the box has focus
 * the frame is orange and the next key press is recorded: a combination with a
 * modifier or a function key becomes the shortcut; a bare key, a combination of
 * common actions (Command+Q, Control+C…), one the `check` refuses or one the
 * system refuses when it is saved says why and keeps the old shortcut. Escape
 * or leaving the field keeps the old one.
 */
export function ShortcutRecorder({
  label,
  value,
  platform,
  autoStart = false,
  check,
  onChange,
  onCancel,
}: {
  label: string;
  value: string;
  platform: string;
  /** Records at once (Dictation shortcut → Custom…). */
  autoStart?: boolean;
  /** Refuses an accelerator this field can't use, with the reason. */
  check?: (accelerator: string) => keyof typeof shortcutProblems | undefined;
  /**
   * Keeps the shortcut. A promise that rejects means the system refused it
   * (another app holds it, or it isn't supported): the field says so.
   */
  onChange: (value: string) => void | Promise<unknown>;
  /** Recording ended without a shortcut. */
  onCancel?: () => void;
}) {
  const [recording, setRecording] = useState(autoStart);
  const problemId = useId();
  const [problem, setProblem] = useState<keyof typeof shortcutProblems>();
  const leave = () => {
    setRecording(false);
    setProblem(undefined);
    onCancel?.();
  };
  return (
    <span className={`shortcut-recorder ${recording ? "recording" : ""}`}>
      <button
        type="button"
        aria-label={`${label}: ${value ? acceleratorLabel(value, platform) : "none"}`}
        aria-describedby={problem ? problemId : undefined}
        autoFocus={autoStart}
        onClick={(event) => event.currentTarget.focus()}
        onFocus={() => setRecording(true)}
        onBlur={leave}
        onKeyDown={(event) => {
          // Tab moves on; every other key is the shortcut being typed.
          if (
            event.key === "Tab" &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Escape") return leave();
          if (event.nativeEvent.isComposing) return;
          const refused = pressProblem(event.nativeEvent, platform);
          if (refused) return setProblem(refused);
          const next = acceleratorFromPress(event.nativeEvent, platform);
          if (!next) return;
          const bad = check?.(next);
          if (bad) return setProblem(bad);
          setProblem(undefined);
          // A refused save keeps the old shortcut and says why here.
          void onChange(next)?.catch((error: unknown) =>
            setProblem(refusedShortcut(error)),
          );
        }}
      >
        {value ? (
          acceleratorLabel(value, platform)
        ) : (
          <span className="shortcut-recorder-empty">Set shortcut</span>
        )}
      </button>
      {value && (
        <button
          type="button"
          className="shortcut-recorder-clear"
          aria-label={formatText("Clear {label}", { label })}
          title="Clear shortcut"
          // Pressed before the field's own blur ends the recording.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setProblem(undefined);
            onChange("");
          }}
        >
          <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
            <circle cx="7.5" cy="7.5" r="7" fill="currentColor" />
            <path
              d="M5.2 5.2l4.6 4.6M9.8 5.2 5.2 9.8"
              className="shortcut-recorder-x"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
      {problem && (
        <p id={problemId} className="shortcut-recorder-problem" role="alert">
          {shortcutProblems[problem]}
        </p>
      )}
    </span>
  );
}
