import { type MenuItemConstructorOptions } from "electron";
import path from "node:path";
import type { AppCommand, Conversation } from "../../shared/types";
import type { TrayStatus } from "./desktop-integration";

/** Fixed labels in the app's language; names (folders, titles) are kept. */
export function translateMenu(
  items: MenuItemConstructorOptions[],
  translate: (text: string) => string,
): MenuItemConstructorOptions[] {
  return items.map((item) => ({
    ...item,
    ...(item.label && !item.id?.startsWith("name:")
      ? { label: translate(item.label) }
      : {}),
    ...(Array.isArray(item.submenu)
      ? {
          submenu: translateMenu(
            item.submenu as MenuItemConstructorOptions[],
            translate,
          ),
        }
      : {}),
  }));
}

/** At most three recent folders, five waiting sessions (2.37337.1 Bqn, Vqn). */
const dockFolders = 3;

const dockWaiting = 5;

const dockTitle = (text: string) =>
  text.replace(/\s+/g, " ").trim().slice(0, 80);

/**
 * The Dock menu: New Chat; New Code Session, with the last three local folders
 * and Other… when there are any; Continue the latest session; then, under a
 * greyed "Needs Your Input", the sessions waiting for an answer.
 */
export function dockMenuTemplate(input: {
  conversations: readonly Conversation[];
  /** Conversations with a Code or Cowork request waiting. */
  waiting: ReadonlySet<string>;
  folderExists: (folder: string) => boolean;
  /** The words around a name ("Continue “{title}”"). */
  translate?: (text: string) => string;
  run: (
    command: AppCommand,
    extra?: { conversationId?: string; folder?: string },
  ) => void;
}): MenuItemConstructorOptions[] {
  const sessions = input.conversations
    .filter((c) => c.mode === "code" && !c.archived && !c.incognito)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const folders = [
    ...new Set(
      sessions
        .map((c) => c.worktree?.origin ?? c.cwd)
        .filter((folder): folder is string => Boolean(folder)),
    ),
  ]
    .filter(input.folderExists)
    .slice(0, dockFolders);
  const newSession: MenuItemConstructorOptions = folders.length
    ? {
        label: "New Code Session",
        submenu: [
          ...folders.map((folder) => ({
            id: `name:${folder}`,
            label: dockTitle(path.basename(folder) || folder),
            click: () => input.run("new-code-session-in", { folder }),
          })),
          { type: "separator" as const },
          { label: "Other…", click: () => input.run("open-folder") },
        ],
      }
    : { label: "New Code Session", click: () => input.run("area-code") };
  const items: MenuItemConstructorOptions[] = [
    { label: "New Chat", click: () => input.run("new-chat") },
    newSession,
  ];
  const last = sessions[0];
  if (last)
    items.push({
      id: `name:continue`,
      label: (input.translate ?? ((text) => text))(
        "Continue “{title}”",
      ).replace(
        "{title}",
        dockTitle(
          last.title || path.basename(last.cwd ?? "") || "Last Session",
        ),
      ),
      click: () => input.run("open-conversation", { conversationId: last.id }),
    });
  const waiting = input.conversations
    .filter((c) => input.waiting.has(c.id) && !c.archived && !c.incognito)
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, dockWaiting);
  if (waiting.length)
    items.push(
      { type: "separator" },
      { label: "Needs Your Input", enabled: false },
      ...waiting.map((c) => ({
        id: `name:${c.id}`,
        label: dockTitle(
          c.title ||
            (c.mode === "code"
              ? path.basename(c.cwd ?? "") || "Code Session"
              : "Task"),
        ),
        click: () => input.run("open-conversation", { conversationId: c.id }),
      })),
    );
  return items;
}

/**
 * The menu bar icon's menu: Show App, then the plan and usage as greyed lines
 * when there are any, then Quit. The original has no New Chat entry here.
 */
export function trayMenuTemplate(options: {
  appName: string;
  status?: TrayStatus;
  show: () => void;
  quit: () => void;
}): MenuItemConstructorOptions[] {
  const { status } = options;
  const lines: MenuItemConstructorOptions[] = [];
  if (status?.plan)
    lines.push({ label: `${status.plan} plan`, enabled: false });
  if (status?.usageUnavailable)
    lines.push({ label: "Usage unavailable", enabled: false });
  if (status?.usagePercent !== undefined)
    lines.push({
      label: `Usage: ${Math.round(status.usagePercent)}%`,
      enabled: false,
    });
  return [
    { label: "Show App", click: options.show },
    { type: "separator" },
    ...(lines.length ? [...lines, { type: "separator" as const }] : []),
    { label: `Quit ${options.appName}`, click: options.quit },
  ];
}
