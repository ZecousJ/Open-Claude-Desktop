import { SelectField } from "./controls";
import { ShortcutRecorder } from "./ShortcutRecorder";
import { t } from "../i18n";
import "./voice-shortcut.css";

export function voiceShortcutOptions(customSupported: boolean) {
  return [
    { value: "capslock", label: "Caps Lock" },
    ...(customSupported ? [{ value: "custom", label: "Custom…" }] : []),
    { value: "off", label: "No shortcut" },
  ];
}

/** Native voice shortcut (live claude.ai bundle, 2026-10-14, c71860c77-yHKjimoi). */
export function VoiceShortcut({
  value,
  platform,
  customSupported,
  onChange,
  onError,
}: {
  value: string;
  platform: string;
  customSupported: boolean;
  onChange: (value: string) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const doubleTap = value === "double-tap-capslock";
  const custom = value !== "off" && value !== "capslock" && !doubleTap;
  return (
    <div className="voice-shortcut">
      <div className="voice-shortcut-control">
        <SelectField<string>
          label="Voice shortcut"
          value={custom ? "custom" : value}
          options={
            doubleTap
              ? [
                  ...voiceShortcutOptions(customSupported),
                  { value, label: "Double-tap Caps Lock" },
                ]
              : voiceShortcutOptions(customSupported)
          }
          onChange={(next) => {
            void onChange(
              next === "custom" ? "Command+Shift+Alt+Space" : next,
            ).catch(onError);
          }}
        />
        {custom && value !== "Cmd+Alt+Space" && customSupported && (
          <ShortcutRecorder
            label="Voice shortcut"
            value={custom ? value : ""}
            platform={platform}
            onChange={onChange}
          />
        )}
      </div>
      {value === "capslock" && (
        <p>
          {t(
            "Press once to start dictation, and press again when you’re done speaking.",
          )}
        </p>
      )}
    </div>
  );
}
