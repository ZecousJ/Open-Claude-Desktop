import { useState } from "react";
import { acceleratorLabel } from "../../shared/accelerator";
import {
  defaultDictationShortcut,
  type DictationShortcutPreference,
} from "../../shared/settings-extras";
import { SelectField } from "./controls";
import { ShortcutRecorder } from "./ShortcutRecorder";

/**
 * Dictation shortcut (R-1410, R-1411, R-1576): a select with the default
 * (Ctrl+D, ⌘D), Custom… and No shortcut. Custom… swaps in a recorder; a
 * recorded shortcut then shows as the select's own first choice.
 */
export function DictationShortcut({
  value,
  platform,
  onChange,
}: {
  value: DictationShortcutPreference;
  platform: string;
  onChange: (value: DictationShortcutPreference) => void | Promise<void>;
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
          await onChange({ accelerator: next });
          setRecording(false);
        }}
      />
    );
  const custom =
    typeof value === "object"
      ? value.accelerator
      : value && value !== defaultDictationShortcut
        ? value
        : undefined;
  return (
    <div>
      <SelectField<string>
        label="Dictation shortcut"
        value={custom === undefined ? String(value) : "custom"}
        options={[
          {
            value: defaultDictationShortcut,
            label: acceleratorLabel(defaultDictationShortcut, platform),
          },
          { value: "custom", label: "Custom…" },
          { value: "", label: "No shortcut" },
        ]}
        onChange={(next) => {
          if (next === "custom") setRecording(true);
          else onChange(next);
        }}
      />
      {custom !== undefined && (
        <ShortcutRecorder
          label="Dictation shortcut"
          value={custom}
          platform={platform}
          onChange={(accelerator) => onChange({ accelerator })}
        />
      )}
    </div>
  );
}
