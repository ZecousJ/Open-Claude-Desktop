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

/** Native voice shortcut. */
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
  const custom = value !== "off" && value !== "capslock";
  return (
    <div className="voice-shortcut">
      <div className="voice-shortcut-control">
        <SelectField<string>
          label="Voice shortcut"
          value={custom ? "custom" : value}
          options={voiceShortcutOptions(customSupported)}
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
            onChange={(next) => onChange(next || "off")}
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
