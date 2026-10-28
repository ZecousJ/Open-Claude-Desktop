import type { AppController } from "../../app/AppContext";
import type { PaletteAction } from "./search-model";

/**
 * Publish only commands backed by this window's actual controller. O16 Ls
 * derives availability from a registered executor.
 */
export function controllerPaletteActions(
  app: AppController | null | undefined,
): PaletteAction[] {
  if (!app) return [];
  const actions: PaletteAction[] = [];
  const add = (
    key: string,
    title: string,
    group: PaletteAction["group"],
    execute: (() => void | Promise<void>) | undefined,
    searchHints?: string[],
    keepsPaletteOpen?: boolean,
    icon?: PaletteAction["icon"],
  ) => {
    if (execute)
      actions.push({
        key,
        kind: "action",
        title,
        group,
        searchHints,
        keepsPaletteOpen,
        icon,
        command: { type: "execute", execute },
      });
  };
  if (app.setPage) {
    add(
      "recents",
      "Recents",
      "navigation",
      () => app.setPage("history"),
      ["history", "conversations", "messages", "sessions"],
      false,
      "Clock",
    );
    add(
      "projects",
      "Projects",
      "navigation",
      () => app.setPage("projects"),
      undefined,
      false,
      "Projects",
    );
    add(
      "artifacts",
      "Artifacts",
      "navigation",
      () => app.setPage("artifacts"),
      ["creations", "generated", "files"],
      false,
      "Artifacts",
    );
  }
  if (app.setPage && app.host?.capabilities.scheduledTasks)
    add(
      "scheduled",
      "Scheduled",
      "navigation",
      () => app.setPage("scheduled"),
      ["scheduled tasks", "cron"],
      false,
      "Clock",
    );
  if (app.openSettingsTab)
    add(
      "settings-general",
      "General",
      "settings",
      () => app.openSettingsTab("general"),
      ["settings"],
      false,
      "Settings",
    );
  if (app.sidebarView?.toggle)
    add(
      "toggle-sidebar",
      "Toggle sidebar",
      "general",
      () => app.sidebarView.toggle(),
      undefined,
      false,
      "Sidebar",
    );
  if (app.setShortcutsOpen)
    add(
      "keyboard-shortcuts",
      "Keyboard shortcuts",
      "general",
      () => app.setShortcutsOpen(true),
      undefined,
      false,
      "Keyboard",
    );
  return actions;
}
