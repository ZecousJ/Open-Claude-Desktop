import { ArrowUpRight } from "../ui/glyphs";
import { t } from "../i18n";

// The default shortcut's keys, drawn as keycaps.
const shortcutKeys = {
  macos: ["⌥ Option", "Space"],
  windows: ["Ctrl", "Alt", "Space"],
  linux: ["Ctrl", "Alt", "Space"],
};

/** Quick Entry's onboarding step: the shortcut and a way to try it. */
export default function QuickEntryOnboarding({
  platform,
  onSettings,
  onContinue,
}: {
  platform: string;
  onSettings: () => void;
  onContinue: () => void;
}) {
  const system =
    platform === "darwin"
      ? "macos"
      : platform === "linux"
        ? "linux"
        : "windows";
  const [before, after] = t(
    "Use {quickEntry} to send messages and screenshots to Claudex from any app",
  ).split("{quickEntry}");
  return (
    <div className="onboarding-quick-entry">
      <h1 tabIndex={-1}>
        {before}
        <em>{t("Quick Entry")}</em>
        {after}
      </h1>
      <button
        type="button"
        className="onboarding-quick-settings"
        onClick={onSettings}
      >
        {t("Quick entry settings")}
        <ArrowUpRight size={16} />
      </button>
      <div className="onboarding-quick-illustrations">
        <div
          className="onboarding-quick-keys"
          role="img"
          aria-label={t(
            platform === "darwin"
              ? "Keyboard shortcut on macOS"
              : platform === "linux"
                ? "Keyboard shortcut"
                : "Keyboard shortcut on Windows",
          )}
        >
          {shortcutKeys[system].map((key, index) => (
            <kbd
              key={key}
              data-wide={index === shortcutKeys[system].length - 1}
            >
              {key}
            </kbd>
          ))}
        </div>
      </div>
      <div className="onboarding-quick-actions">
        <button type="button" className="secondary" onClick={onContinue}>
          {t("Skip")}
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => {
            void window.desktop.openQuickEntry().catch(() => {});
            onContinue();
          }}
        >
          {t("Try Quick Entry")}
        </button>
      </div>
    </div>
  );
}
