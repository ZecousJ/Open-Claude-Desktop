import { useState } from "react";
import { acceleratorLabel } from "../../shared/accelerator";
import { SelectField } from "./controls";
import { ShortcutRecorder } from "./ShortcutRecorder";

export const defaultDictationShortcut = "CommandOrControl+D";

/**
 * Dictation shortcut: a select with the default (Ctrl+D, ⌘D), Custom… and No
 * shortcut. Custom… swaps in a recorder; a recorded shortcut then shows as the
 * select's own first choice.
 */
export function DictationShortcut({
  value,
  platform,
  onChange,
}: {
  value: string;
  platform: string;
  onChange: (value: string) => void | Promise<void>;
}) {
  const [recording, setRecording] = useState(false);
  if (recording)
    return (
      <ShortcutRecorder
        label="Dictation shortcut"
        value=""
        platform={platform}
        autoStart
        onCancel={() => setRecording(false)}
        onChange={async (next) => {
          await onChange(next);
          setRecording(false);
        }}
      />
    );
  const custom = value && value !== defaultDictationShortcut ? value : "";
  return (
    <SelectField<string>
      label="Dictation shortcut"
      value={value}
      options={[
        {
          value: defaultDictationShortcut,
          label: acceleratorLabel(defaultDictationShortcut, platform),
        },
        ...(custom
          ? [{ value: custom, label: acceleratorLabel(custom, platform) }]
          : []),
        { value: "custom", label: "Custom…" },
        { value: "", label: "No shortcut" },
      ]}
      onChange={(next) => {
        if (next === "custom") setRecording(true);
        else onChange(next);
      }}
    />
  );
}
