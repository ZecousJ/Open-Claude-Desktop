import { useState } from "react";
import { SelectField } from "./controls";
import {
  ShortcutRecorder,
  refusedShortcut,
  shortcutProblems,
} from "./ShortcutRecorder";
import { t } from "../i18n";
import "./quick-access-shortcut.css";

/** Or. */
export function QuickAccessShortcut({
  value,
  platform,
  onChange,
}: {
  value: string;
  platform: string;
  onChange: (value: string) => Promise<void>;
}) {
  const [problem, setProblem] = useState<string>();
  const custom = !["off", "double-tap-option", "Alt+Space"].includes(value);
  return (
    <div className="quick-access-shortcut">
      <SelectField<string>
        label="Quick access shortcut"
        value={custom ? "custom" : value}
        width={220}
        options={[
          {
            value: "double-tap-option",
            label: platform === "darwin" ? "Tap Option twice" : "Tap Alt twice",
          },
          {
            value: "Alt+Space",
            label: platform === "darwin" ? "Option+Space" : "Alt+Space",
          },
          { value: "custom", label: "Custom…" },
          { value: "off", label: "No shortcut" },
        ]}
        onChange={(next) => {
          setProblem(undefined);
          void onChange(next === "custom" ? "Command+Shift+Space" : next).catch(
            (error) => setProblem(shortcutProblems[refusedShortcut(error)]),
          );
        }}
      />
      {custom && (
        <ShortcutRecorder
          label={t("Quick access shortcut")}
          value={value}
          platform={platform}
          onChange={onChange}
        />
      )}
      {problem && (
        <p className="shortcut-recorder-problem" role="alert">
          {t(problem)}
        </p>
      )}
    </div>
  );
}
