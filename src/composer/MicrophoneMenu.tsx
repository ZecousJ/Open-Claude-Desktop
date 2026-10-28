import type { VoiceInputChoice } from "./voice-input-preference";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Check } from "../ui/glyphs";
import { useDismiss } from "../ui/useDismiss";
import { MenuSheetScrim } from "./MenuSheetScrim";
import {
  useComposerMenuPresentation,
  useComposerMenuSheet,
} from "./menu-sheet";
import { DictationLevels } from "../voice/DictationLevels";
import { AppIcon } from "../ui/app-icon";
import { useLocale, useT } from "../i18n";
import { DictationLanguageMenu } from "./DictationLanguageMenu";
import { dictationLanguages } from "./dictation-languages";
import {
  selectedDictationLanguage,
  subscribeDictationLanguage,
} from "../voice/dictation-language";
import { SUBMENU_OPEN_DELAY_MS } from "../ui/menu-keys";
import "./microphone-menu.css";
import {
  setHoldToRecord,
  setMicrophoneDevice,
  useMicrophonePreferences,
} from "../voice/preferences";

export type MicrophoneDevice = { id: string; label: string };

/** The computer's inputs. Names appear once the page has been allowed to record. */
export async function inputDevices(): Promise<MicrophoneDevice[]> {
  try {
    const all = (await navigator.mediaDevices?.enumerateDevices()) ?? [];
    let unnamed = 0;
    return all
      .filter((device) => device.kind === "audioinput")
      .map((device) => ({
        id: device.deviceId,
        label:
          device.label ||
          (device.deviceId === "default"
            ? "Default"
            : device.deviceId === "communications"
              ? "Communications"
              : `Microphone ${++unnamed}`),
      }));
  } catch {
    return [];
  }
}

/**
 * The chosen input's level while the menu is open. Only where recording is
 * already allowed, so opening the menu never asks for the microphone.
 */
function useInputLevel(
  deviceId: string,
  enabled: boolean,
): MediaStream | undefined {
  const [input, setInput] = useState<MediaStream>();
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let cleanup = () => {};
    void (async () => {
      try {
        const state = await navigator.permissions?.query({
          name: "microphone" as PermissionName,
        });
        if (stopped || state?.state !== "granted") return;
        const audio: MediaTrackConstraints = {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          ...(deviceId && deviceId !== "default"
            ? { deviceId: { exact: deviceId } }
            : {}),
        };
        const stream = await navigator.mediaDevices.getUserMedia({ audio });
        if (stopped) return stream.getTracks().forEach((t) => t.stop());
        setInput(stream);
        cleanup = () => {
          stream.getTracks().forEach((t) => t.stop());
        };
      } catch {
        // No meter: the menu works without it.
      }
    })();
    return () => {
      stopped = true;
      cleanup();
      setInput(undefined);
    };
  }, [deviceId, enabled]);
  return input;
}

/**
 * The ⌄ after the microphone opens this: a "Microphone" heading over the
 * computer's inputs, the chosen one ticked (the system default at first), then
 * Language › and a "Hold to record" switch below a rule. The choices are used
 * by dictation (src/DictationButton.tsx).
 */
export function MicrophoneMenu({
  anchor,
  onClose: closeImmediately,
  variant = "legacy",
  voiceInput,
}: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Current idle Chat menu; Code/native callers retain their legacy controls. */
  variant?: "idle" | "legacy";
  voiceInput?: VoiceInputChoice;
}) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const languageAnchor = useRef<HTMLButtonElement>(null);
  const languageBox = useRef<HTMLDivElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [languageOpen, setLanguageOpen] = useState(false);
  const sheet = useComposerMenuPresentation();
  const sheetMotion = useComposerMenuSheet(box, {
    sheet,
    nested: languageOpen,
    panelRef: languageBox,
    trigger: languageAnchor,
    onBack: () => {
      setLanguageOpen(false);
      languageAnchor.current?.focus();
    },
  });
  const onClose = () => sheetMotion.dismiss(closeImmediately);
  const locale = useLocale();
  const language = useSyncExternalStore(
    subscribeDictationLanguage,
    selectedDictationLanguage,
    () => "",
  );
  const languageLabel =
    dictationLanguages(locale).find((item) => item.value === language)?.label ??
    t("Auto");
  const openLanguage = () => {
    clearTimeout(openTimer.current);
    setLanguageOpen(true);
  };
  const backFromLanguage = () => {
    sheetMotion.back();
  };
  useEffect(() => () => clearTimeout(openTimer.current), []);
  const [devices, setDevices] = useState<MicrophoneDevice[]>();
  const [place, setPlace] = useState<{
    left: number;
    bottom?: number;
    top?: number;
  }>();
  const { device, hold } = useMicrophonePreferences();
  const idle = variant === "idle";
  const input = useInputLevel(device, !idle);
  useDismiss([box, anchor, languageBox], true, onClose);
  useEffect(() => {
    let live = true;
    let revision = 0;
    const changed = async () => {
      const current = ++revision;
      const found = await inputDevices();
      if (live && current === revision) setDevices(found);
    };
    void changed();
    navigator.mediaDevices?.addEventListener?.("devicechange", changed);
    box.current?.focus();
    return () => {
      live = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", changed);
    };
  }, []);
  // Above the ⌄, its left edge 2px before it, kept inside the window.
  useLayoutEffect(() => {
    const trigger = anchor.current?.getBoundingClientRect();
    const width = box.current?.offsetWidth || (idle ? 165 : 320);
    if (!trigger) return;
    const height = box.current?.offsetHeight ?? 139;
    const below = idle && innerHeight - trigger.bottom >= height + 12;
    setPlace({
      left: Math.max(
        8,
        Math.min(
          idle ? trigger.right - width : trigger.left - 2,
          innerWidth - width - 8,
        ),
      ),
      ...(below
        ? { top: trigger.bottom + 6 }
        : { bottom: innerHeight - trigger.top + 6 }),
    });
  }, [idle]);
  // Only an enumerated device may be selected. Empty/failed enumeration
  // must never manufacture a selectable Default microphone.
  const rows = devices ?? [];
  const chosen = rows.some((row) => row.id === device)
    ? device
    : rows.find((row) => row.id === "default")?.id;
  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      box.current?.querySelectorAll<HTMLElement>(
        '[role^="menuitem"]:not(:disabled)',
      ) ?? [],
    );
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length;
    items[next]?.focus();
  };
  const languageRow = (
    <button
      ref={languageAnchor}
      type="button"
      role="menuitem"
      className="microphone-language-status"
      aria-haspopup="menu"
      aria-expanded={languageOpen}
      onClick={openLanguage}
      onPointerEnter={() => {
        if (sheet) return;
        openTimer.current = setTimeout(openLanguage, SUBMENU_OPEN_DELAY_MS);
      }}
      onPointerLeave={() => clearTimeout(openTimer.current)}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") {
          event.preventDefault();
          event.stopPropagation();
          openLanguage();
        }
      }}
    >
      <span>{t("Language")}</span>
      <span className="microphone-language-value">
        {languageLabel}
        <AppIcon name="CaretRight" size={12} />
      </span>
    </button>
  );
  return createPortal(
    <>
      <MenuSheetScrim onClose={onClose} />
      <div
        ref={box}
        className={`microphone-menu${idle ? " microphone-menu-idle" : ""}`}
        role="menu"
        aria-label={t(voiceInput ? "Voice input" : "Dictation settings")}
        tabIndex={-1}
        style={place ?? { left: 0, bottom: 0, visibility: "hidden" }}
        onKeyDown={keydown}
      >
        {idle && (
          <div role="presentation" className="microphone-status">
            <AppIcon name="Microphone" size={16} />
            <span className="sr-only">{t("Microphone")}</span>
          </div>
        )}
        {!idle && (
          <header>
            {t("Microphone")}
            <DictationLevels stream={input} />
          </header>
        )}
        {voiceInput && (
          <>
            {(["dictation", "voice"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={voiceInput.value === value}
                onClick={() => {
                  voiceInput.choose(value);
                  onClose();
                }}
              >
                <span>
                  {t(value === "dictation" ? "Dictate" : "Voice mode")}
                </span>
                {voiceInput.value === value && <Check size={13} />}
              </button>
            ))}
            <hr />
          </>
        )}
        {!rows.length && (
          <button type="button" role="menuitem" disabled>
            {t(devices ? "No devices found" : "Loading...")}
          </button>
        )}
        {rows.map((row) => (
          <button
            key={row.id}
            role="menuitemradio"
            aria-checked={chosen === row.id}
            title={row.label}
            onClick={() => {
              setMicrophoneDevice(row.id);
              onClose();
            }}
          >
            <span data-no-translate>{row.label}</span>
            {chosen === row.id && <Check size={13} />}
          </button>
        ))}
        <hr />
        {idle && (
          <div className="microphone-settings-heading">
            {t("Dictation settings")}
          </div>
        )}
        {languageRow}
        {!idle && (
          <button
            role="menuitemcheckbox"
            aria-checked={hold}
            onClick={() => setHoldToRecord(!hold)}
          >
            <span>{t("Hold to record")}</span>
            <i className="microphone-switch" data-enabled={hold} aria-hidden />
          </button>
        )}
      </div>
      {languageOpen && (
        <DictationLanguageMenu
          anchor={languageAnchor}
          frame={languageBox}
          value={language}
          onBack={backFromLanguage}
          onDone={onClose}
        />
      )}
    </>,
    document.body,
  );
}
