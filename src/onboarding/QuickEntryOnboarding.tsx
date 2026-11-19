import { ArrowUpRight } from "../ui/glyphs";
import { t } from "../i18n";

// Kept with the app rather than fetched from the web; the menu bar
// picture is left out, as it shows another app's icon.
const keyboardArt = {
  macos: new URL("./art/keyboard-macos.svg", import.meta.url).href,
  windows: new URL("./art/keyboard-windows.svg", import.meta.url).href,
  linux: new URL("./art/keyboard-linux.svg", import.meta.url).href,
};

/** Cr (live claude.ai bundle, 2026-10-14, cc20c35ef-BQMTespy). */
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
        <img
          loading="lazy"
          src={keyboardArt[system]}
          width={222}
          height={129}
          alt={t(
            platform === "darwin"
              ? "Keyboard shortcut on macOS"
              : platform === "linux"
                ? "Keyboard shortcut"
                : "Keyboard shortcut on Windows",
          )}
        />
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
