import { helpUrl } from "../../../shared/help-links";
import { Suspense, useState } from "react";
import { lazyPiece } from "../../ui/lazy-piece";
import { t } from "../../i18n";
import { ArrowUpRight, RefreshCw } from "../../ui/glyphs";
import { preference } from "../../../shared/settings-extras";
import { Button, Row, Section, Toggle, Value } from "../controls";
import type { TabProps } from "../context";
import { useLoaded } from "../pageControls";
import { ShortcutRecorder } from "../ShortcutRecorder";
import { DictationShortcut } from "../DictationShortcut";
import { VoiceShortcut } from "../VoiceShortcut";
import { QuickAccessShortcut } from "../QuickAccessShortcut";
import { ComputerUseSection } from "../../computer-use/ComputerUseSection";
import { StorageDialog } from "../storage/StorageDialog";
import { BrowserLinkPreferences } from "./BrowserLinkPreferences";
import "../desktop.css";
import "../original-rows.css";

/** Rows Settings search finds on this page. */
export { systemLabels as searchLabels } from "./desktop-labels";

const engineState = {
  ready: "Connected",
  starting: "Starting",
} as Record<string, string>;

const BrowserActionsDialog = lazyPiece(
  () => import("./BrowserActionsDialog"),
  "BrowserActionsDialog",
);

/**
 * System. Login item, the Quick access shortcut, the menu bar (tray) icon,
 * keeping the computer awake while Claudex is open and the storage it uses,
 * then Computer use (R10) where the policy, this computer and the bundled
 * driver allow it. Browser actions use the built-in browser. Chrome account
 * pairing is not supported by Claudex.
 */
export function SystemTab({
  settings,
  save,
  engine,
  platform,
  onError,
}: TabProps) {
  const system = useLoaded(() => window.desktop.systemState(), onError);
  const [storage, setStorage] = useState(false);
  const [browserWarning, setBrowserWarning] = useState(false);
  const state = system.value;
  const tray = platform === "darwin" ? "Menu bar" : "System tray";
  return (
    <div className="desktop-page">
      <Section title="System">
        <Row label="Desktop app version">
          <Value>{__APP_VERSION__}</Value>
        </Row>
        {state && state.runOnStartup !== null && (
          <Row
            label="Run on startup"
            description="Automatically start Claudex when you log in to your computer."
          >
            <Toggle
              label="Run on startup"
              checked={state.runOnStartup}
              onChange={(enabled) =>
                void window.desktop
                  .setRunOnStartup(enabled)
                  .then(system.setValue)
                  .catch(onError)
              }
            />
          </Row>
        )}
        {state?.nativeQuickEntry?.status === "supported" && (
          <Row
            label="Quick access shortcut"
            description="Message Claudex from anywhere on your desktop."
          >
            <QuickAccessShortcut
              value={preference(settings, "quickEntryShortcut")}
              platform={platform}
              onChange={(quickEntryShortcut) =>
                new Promise<void>((resolve, reject) => {
                  void Promise.resolve(
                    save({ quickEntryShortcut }, undefined, reject),
                  ).then(() => resolve());
                })
              }
            />
          </Row>
        )}
        {state && platform !== "darwin" && (
          // A recorder field with a clear button.
          <Row
            label="Quick Entry keyboard shortcut"
            description="Quickly open Claudex from anywhere."
          >
            <ShortcutRecorder
              label="Quick Entry keyboard shortcut"
              value={preference(settings, "quickAccessShortcut")}
              platform={platform}
              // A shortcut another app holds can't be registered: the field
              // says so instead of a toast.
              onChange={(quickAccessShortcut) =>
                new Promise<void>((resolve, reject) => {
                  void Promise.resolve(
                    save({ quickAccessShortcut }, undefined, reject),
                  ).then(() => resolve());
                })
              }
            />
          </Row>
        )}
        {state?.quickEntryDictation && (
          <Row
            label="Voice shortcut"
            description="Speak to Claudex from anywhere on your desktop."
          >
            <VoiceShortcut
              value={preference(settings, "quickEntryDictationShortcut")}
              platform={platform}
              customSupported={state.customQuickEntryDictationShortcut === true}
              onError={onError}
              onChange={(quickEntryDictationShortcut) =>
                new Promise<void>((resolve, reject) => {
                  void Promise.resolve(
                    save({ quickEntryDictationShortcut }, undefined, reject),
                  ).then(() => resolve());
                })
              }
            />
          </Row>
        )}
        {/* The default, Custom… (a recorder) and No shortcut. */}
        <Row
          label="Dictation shortcut"
          description="Start or stop dictation in the chat you’re typing in."
        >
          <DictationShortcut
            value={preference(settings, "dictationShortcut")}
            platform={platform}
            onChange={(dictationShortcut) =>
              new Promise<void>((resolve, reject) => {
                void Promise.resolve(
                  save({ dictationShortcut }, undefined, reject),
                ).then(() => resolve());
              })
            }
          />
        </Row>
        <Row
          label={tray}
          // The window closing leaves Claudex running in the background on
          // every platform; Windows says so. A Linux desktop without tray icons
          // (no StatusNotifier host on the session bus) gets the original's
          // note: closing quits there.
          description={
            platform === "darwin"
              ? "Show Claudex in the menu bar."
              : platform === "win32"
                ? "Keep Claudex running in the system tray."
                : state?.trayIcon === "unsupported"
                  ? "Closing the window quits Claudex because your desktop doesn’t show tray icons."
                  : "Show Claudex in the system tray."
          }
        >
          <Toggle
            label={tray}
            checked={preference(settings, "menuBar")}
            onChange={(menuBar) => save({ menuBar })}
          />
        </Row>
        <Row
          label="Keep computer awake"
          description="Prevent your computer from idle-sleeping while Claudex is open so scheduled tasks can run. Your display can still turn off. Closing the laptop lid will still put it to sleep."
        >
          <Toggle
            label="Keep computer awake"
            checked={preference(settings, "keepAwake")}
            onChange={(keepAwake) => save({ keepAwake })}
          />
        </Row>
        <Row
          label="Storage"
          description="See how much space Claudex uses on this computer."
        >
          <Button size="regular" onClick={() => setStorage(true)}>
            Manage
          </Button>
        </Row>
        <Row
          label="Agent runtime"
          description={
            engine.error ??
            `Bundled open-source Codex · ${engineState[engine.state] ?? "Disconnected"}`
          }
        >
          <Button
            onClick={() => void window.desktop.restartEngine().catch(onError)}
          >
            <RefreshCw size={14} />
            Reconnect
          </Button>
        </Row>
      </Section>
      {/* Settings27: Claudex controls its built-in browser, not account-paired Chrome. */}
      <Section
        title="Browser use"
        tightNote
        note="Controls the built-in browser in local Code sessions. Not available in cloud Code sessions."
      >
        <Row
          label="Allow all browser actions"
          description={
            <>
              {t(
                "Claudex will browse and interact with any website without asking. Applies to new sessions. This setting can put your data at risk.",
              )}{" "}
              <a
                href={helpUrl("browser-safety")}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("Learn more")}
              </a>
            </>
          }
        >
          <Toggle
            label="Allow all browser actions"
            checked={preference(settings, "allowAllBrowserActions")}
            onChange={(allowAllBrowserActions) => {
              if (allowAllBrowserActions) setBrowserWarning(true);
              else void save({ allowAllBrowserActions: false });
            }}
          />
        </Row>
        <BrowserLinkPreferences settings={settings} save={save} />
      </Section>
      <ComputerUseSection platform={platform} onError={onError} />
      <Section title="About Claudex" note="An independent desktop client.">
        <Row label="Agent source code">
          <Button
            onClick={() =>
              void window.desktop
                .openExternal("https://github.com/openai/codex")
                .catch(onError)
            }
          >
            Open-source Codex
            <ArrowUpRight size={14} />
          </Button>
        </Row>
      </Section>
      {storage && <StorageDialog onClose={() => setStorage(false)} />}
      {browserWarning && (
        <Suspense fallback={null}>
          <BrowserActionsDialog
            onClose={() => setBrowserWarning(false)}
            onAllow={() => {
              setBrowserWarning(false);
              void save({ allowAllBrowserActions: true });
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
