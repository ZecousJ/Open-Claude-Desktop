import {
  app,
  globalShortcut,
  Menu,
  nativeImage,
  powerMonitor,
  powerSaveBlocker,
  Tray,
} from "electron";
import fs from "node:fs";
import { quickEntryDictationSupported } from "./quick-access";
import { nativeTranslator } from "./native-i18n";
import { preference } from "../../shared/settings-extras";
import { wantsKeepAwake } from "../engine/attention-rules";
import {
  translateMenu,
  dockMenuTemplate,
  trayMenuTemplate,
} from "./desktop-menus";
import type { DesktopIntegration } from "./desktop-integration";

/**
 * A session's own Keep computer awake changed, or a session left (the
 * main process's event listener calls this on conversation events).
 */
export function refreshKeepAwake(this: DesktopIntegration) {
  this.updateKeepAwake();
  this.refreshDockMenu();
}

/** The menus' words in the app's language (loaded once per language). */
export function translate(this: DesktopIntegration): (text: string) => string {
  const settings = this.options.settings();
  const locale = settings ? preference(settings, "locale") : "en-US";
  if (this.translation?.locale === locale) return this.translation.translate;
  void nativeTranslator(locale)
    .then((translate) => {
      this.translation = { locale, translate };
      this.dockMenuKey = "";
      this.refreshDockMenu();
    })
    .catch(() => {});
  return this.translation?.translate ?? ((text) => text);
}

/**
 * The Dock icon's menu: rebuilt when the sessions or the requests waiting
 * change.
 */
export function refreshDockMenu(this: DesktopIntegration) {
  if (process.platform !== "darwin" || !this.ready || !app.dock) return;
  const settings = this.options.settings();
  const waiting = new Set(
    [...this.waiting.values()]
      .filter((entry) => entry.kind)
      .map((entry) => entry.conversationId)
      .filter((id): id is string => Boolean(id)),
  );
  const template = settings
    ? dockMenuTemplate({
        conversations: this.options.conversations(),
        waiting,
        folderExists: (folder) => fs.existsSync(folder),
        translate: this.translate(),
        run: (command, extra) => {
          this.showMain();
          this.options.command(command, extra);
        },
      })
    : [];
  const translated = translateMenu(template, this.translate());
  const key = JSON.stringify(translated, (name, value) =>
    name === "click" ? undefined : value,
  );
  if (key === this.dockMenuKey) return;
  this.dockMenuKey = key;
  app.dock.setMenu(Menu.buildFromTemplate(translated));
}

export function updateKeepAwake(this: DesktopIntegration) {
  if (!this.ready) return;
  const settings = this.options.settings();
  const now = this.now();
  // Code work holds the computer awake with the original's grace, stall
  // and limit (attention-rules.ts); the next change is checked by timer.
  if (this.keepAwakeTimer) clearTimeout(this.keepAwakeTimer);
  this.keepAwakeTimer = undefined;
  const change = this.work.nextChange(now);
  const next = this.work.holding(now)
    ? Math.min(change ?? 60_000, 60_000)
    : change;
  if (next !== undefined) {
    this.keepAwakeTimer = setTimeout(() => this.updateKeepAwake(), next + 50);
    this.keepAwakeTimer.unref?.();
  }
  const wanted =
    !!settings &&
    wantsKeepAwake({
      keepAwake: preference(settings, "keepAwake"),
      keepAwakeWhileCoding: preference(settings, "keepAwakeWhileCoding"),
      keepAwakeOnBattery: preference(settings, "keepAwakeOnBattery"),
      onBattery: powerMonitor.isOnBatteryPower(),
      codeRunning: this.work.holding(now),
      sessionKeepAwake: this.options
        .conversations()
        .some((c) => c.mode === "code" && c.keepAwake && !c.archived),
    });
  if (wanted && this.blocker === undefined)
    this.blocker = powerSaveBlocker.start("prevent-app-suspension");
  if (!wanted && this.blocker !== undefined) {
    powerSaveBlocker.stop(this.blocker);
    this.blocker = undefined;
  }
  const codeHold = Boolean(
    settings &&
    preference(settings, "keepAwakeWhileCoding") &&
    this.work.holding(now) &&
    (!powerMonitor.isOnBatteryPower() ||
      preference(settings, "keepAwakeOnBattery")),
  );
  if (this.codeHold || codeHold) {
    for (const conversation of this.options.conversations()) {
      if (
        conversation.mode !== "code" ||
        conversation.environment?.kind === "space" ||
        conversation.environment?.kind === "ssh"
      )
        continue;
      const turn = conversation.turns.at(-1);
      this.awakeNotices.observe(
        conversation.id,
        turn?.status === "inProgress",
        turn?.status === "completed",
        now,
        powerMonitor.getSystemIdleTime() * 1000,
      );
    }
  }
  if (this.codeHold && !codeHold) {
    const completed = this.awakeNotices.release(
      Boolean(
        settings &&
        preference(settings, "keepAwakeWhileCoding") &&
        (!powerMonitor.isOnBatteryPower() ||
          preference(settings, "keepAwakeOnBattery")),
      ),
    );
    if (completed)
      this.options.keptAwake?.(completed.sessionId, completed.heldMs);
  }
  this.codeHold = codeHold;
}

export function updateTray(this: DesktopIntegration, show: boolean) {
  if (!show || this.trayUnsupported || !fs.existsSync(this.options.trayIcon)) {
    this.tray?.destroy();
    this.tray = undefined;
    return;
  }
  if (!this.tray) {
    const image = nativeImage.createFromPath(this.options.trayIcon);
    // The template file is 16px with its @2x; the others are resized here.
    const sized = /Template(?:@2x)?\.png$/.test(this.options.trayIcon)
      ? image
      : image.resize({ width: 16, height: 16 });
    this.tray = new Tray(sized);
    this.tray.setToolTip("Claudex");
    // A click brings up Quick Entry, as the original's does, and shows the
    // main window when there is none; the menu opens on a right click.
    // Linux tray hosts report no clicks, so the menu stays attached there.
    this.tray.on("click", () => {
      if (this.options.quickEntry) this.options.quickEntry();
      else this.showMain();
    });
    this.tray.on("right-click", () => {
      if (process.platform !== "linux")
        this.tray?.popUpContextMenu(this.trayMenu());
    });
  }
  if (process.platform === "linux") this.tray.setContextMenu(this.trayMenu());
}

export function trayMenu(this: DesktopIntegration) {
  return Menu.buildFromTemplate(
    translateMenu(
      trayMenuTemplate({
        appName: app.name,
        status: this.options.trayStatus?.(),
        show: () => this.showMain(),
        quit: () => app.quit(),
      }),
      this.translate(),
    ),
  );
}

/**
 * Registers the Quick Entry shortcut; throws when another app holds it.
 * It brings up the Quick Entry composer, whose prompt starts a new chat
 * in the main window.
 */
export function updateShortcuts(
  this: DesktopIntegration,
  accelerators: string[],
  voice = "",
) {
  if (voice && accelerators.includes(voice))
    throw Error(
      `${voice} is used by another app. Choose a different shortcut.`,
    );
  const next = new Set([...accelerators, voice].filter(Boolean));
  const added: string[] = [];
  for (const accelerator of next) {
    if (this.shortcuts.has(accelerator)) continue;
    if (
      !globalShortcut.register(accelerator, () => {
        const settings = this.options.settings();
        if (
          settings &&
          quickEntryDictationSupported() &&
          preference(settings, "quickEntryDictationShortcut") === accelerator
        )
          this.options.quickEntryDictation?.("toggle");
        else this.openQuickEntry();
      })
    ) {
      for (const registered of added) globalShortcut.unregister(registered);
      throw Error(
        `${accelerator} is used by another app. Choose a different shortcut.`,
      );
    }
    added.push(accelerator);
  }
  for (const accelerator of this.shortcuts)
    if (!next.has(accelerator)) globalShortcut.unregister(accelerator);
  this.shortcuts = next;
}
