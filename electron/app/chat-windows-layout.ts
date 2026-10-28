import { initialCaptionOverlay } from "./caption-overlay";
import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Rectangle,
} from "electron";
import type { ToolPaneKind } from "../../shared/tool-pane";
import { toolPaneKinds } from "../../shared/tool-pane";
import { trafficLightPosition } from "./window-zoom";
import { defaultChatWindowSize } from "./chat-windows-support";
import { minChatWindowSize } from "./chat-windows-support";
import { cascadeOffset } from "./chat-windows-support";
import { stateSchema } from "./chat-windows-support";
import { layoutSchema } from "./chat-windows-support";
import { readChatWindowState } from "./chat-windows-support";
import { writeChatWindowState } from "./chat-windows-support";
import { clampToDisplays } from "./chat-windows-support";
import type { ChatWindows } from "./chat-windows";

export function takeRestorableLayout(this: ChatWindows) {
  const layout = this.sessions.take();
  if (!layout) return null;
  const clamp = <T extends { bounds?: Rectangle }>(entry: T): T => ({
    ...entry,
    ...(entry.bounds
      ? { bounds: clampToDisplays(entry.bounds, this.host.workAreas()) }
      : {}),
  });
  return {
    ...layout,
    popouts: layout.popouts.map(clamp),
    panes: layout.panes.map(clamp),
    projects: layout.projects?.map(clamp),
  };
}

export async function restoreLayout(this: ChatWindows) {
  this.preservingLayout = false;
  const layout = this.takeRestorableLayout();
  if (!layout) return;
  this.restoringLayout = true;
  const handledPanes: { sessionId: string; paneTileId: string }[] = [];
  const handledProjects: string[] = [];
  try {
    for (const entry of [...layout.popouts, ...layout.panes]) {
      if (this.preservingLayout) break;
      const pane =
        "paneTileId" in entry && typeof entry.paneTileId === "string"
          ? entry.paneTileId
          : undefined;
      const conversation = this.host.conversation(entry.sessionId);
      if (!conversation || conversation.incognito) {
        if (pane)
          handledPanes.push({ sessionId: entry.sessionId, paneTileId: pane });
        continue;
      }
      if (pane && !toolPaneKinds.includes(pane as ToolPaneKind)) continue;
      try {
        await this.openConversation(
          entry.sessionId,
          undefined,
          pane as ToolPaneKind | undefined,
          entry.bounds
            ? { bounds: entry.bounds, alwaysOnTop: !!entry.alwaysOnTop }
            : undefined,
        );
      } catch (error) {
        console.error("Pop-out could not be restored:", error);
      }
    }
    for (const entry of layout.projects ?? []) {
      if (this.preservingLayout) break;
      if (!this.host.project?.(entry.projectId)) {
        handledProjects.push(entry.projectId);
        continue;
      }
      try {
        await this.openProject(entry.projectId, entry);
      } catch (error) {
        console.error("Pop-out could not be restored:", error);
      }
    }
  } finally {
    this.restoringLayout = false;
    if (!this.preservingLayout)
      this.sessions.report({
        popouts: [],
        panes: [],
        projects: [],
        handledPanes,
        handledProjects,
      });
    this.saveLayout();
  }
}

export function saveLayout(this: ChatWindows) {
  const file = this.host.layoutPath?.();
  if (!file || this.preservingLayout || this.restoringLayout) return;
  const windows = [...this.open.values()]
    .filter(({ win, conversationId }) => {
      const conversation = this.host.conversation(conversationId);
      return !win.isDestroyed() && conversation && !conversation.incognito;
    })
    .slice(0, 100)
    .map(({ win, conversationId, pane }) => ({
      conversationId,
      pane,
      bounds: win.getNormalBounds(),
      alwaysOnTop: win.isAlwaysOnTop(),
    }));
  const parsed = layoutSchema.safeParse({ version: 1, windows });
  if (!parsed.success) return;
  try {
    this.sessions.report(
      {
        popouts: windows
          .filter((entry) => !entry.pane)
          .slice(0, 50)
          .map(({ conversationId, ...entry }) => ({
            ...entry,
            sessionId: conversationId,
            sessionType: "local",
            isSsh:
              this.host.conversation(conversationId)?.environment?.kind ===
                "ssh" || undefined,
          })),
        panes: windows
          .filter((entry) => entry.pane)
          .slice(0, 50)
          .map(({ conversationId, pane, ...entry }) => ({
            ...entry,
            sessionId: conversationId,
            sessionType: "local",
            paneTileId: pane!,
          })),
        projects: [...this.projects]
          .filter(([win]) => !win.isDestroyed())
          .slice(0, 50)
          .map(([win, projectId]) => ({
            projectId,
            bounds: win.getNormalBounds(),
            alwaysOnTop: win.isAlwaysOnTop(),
          })),
      },
      parsed.data.windows,
    );
  } catch (error) {
    console.error("Pop-out layout could not be saved:", error);
  }
}

export function layoutState(this: ChatWindows) {
  return {
    popoutSessionIds: [...this.open.values()]
      .filter((entry) => !entry.pane && !entry.win.isDestroyed())
      .map((entry) => entry.conversationId),
    visibleSessionIds: [...this.open.values()]
      .filter(
        (entry) => !entry.pane && entry.visible && !entry.win.isDestroyed(),
      )
      .map((entry) => entry.conversationId),
    otherPopoutCount:
      [...this.open.values()].filter(
        (entry) => entry.pane && !entry.win.isDestroyed(),
      ).length +
      [...this.projects.keys()].filter((win) => !win.isDestroyed()).length,
  };
}

export function windowOptions(
  this: ChatWindows,
  title: string,
): BrowserWindowConstructorOptions {
  const dark = this.host.dark();
  const frame: BrowserWindowConstructorOptions =
    this.host.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: trafficLightPosition(0),
        }
      : this.host.platform === "win32"
        ? {
            titleBarStyle: "hidden",
            titleBarOverlay: initialCaptionOverlay(dark),
          }
        : { titleBarStyle: "hidden" };
  return {
    ...this.placement(),
    useContentSize: true,
    minWidth: minChatWindowSize.width,
    minHeight: minChatWindowSize.height,
    title,
    backgroundColor: dark ? "#151515" : "#fcfcfb",
    ...frame,
    webPreferences: this.host.windows.webPreferences(),
  };
}

/**
 * Where a new window opens: off the newest separate window when one is
 * open, else where the last one was closed, else centred (Electron's
 * default) at the default size. Always kept on a display.
 */
export function placement(
  this: ChatWindows,
): Partial<Rectangle> & { width: number; height: number } {
  const saved = readChatWindowState(this.host.statePath())?.last;
  const size = saved
    ? { width: saved.width, height: saved.height }
    : { ...defaultChatWindowSize };
  const newest = [...this.order].reverse().find((win) => !win.isDestroyed());
  const areas = this.host.workAreas();
  if (newest) {
    const from = newest.getBounds();
    return clampToDisplays(
      {
        x: from.x + cascadeOffset,
        y: from.y + cascadeOffset,
        ...size,
      },
      areas,
    );
  }
  if (saved) return clampToDisplays({ x: saved.x, y: saved.y, ...size }, areas);
  const primary = areas[0];
  if (!primary) return size;
  return {
    width: Math.min(size.width, primary.width),
    height: Math.min(size.height, primary.height),
  };
}

export function scheduleSave(this: ChatWindows, win: BrowserWindow) {
  if (this.saveTimer) clearTimeout(this.saveTimer);
  this.saveTimer = setTimeout(() => {
    this.saveTimer = undefined;
    this.saveNow(win);
  }, 500);
}

export function saveNow(this: ChatWindows, win: BrowserWindow) {
  this.saveLayout();
  const file = this.host.statePath();
  if (!file || win.isDestroyed()) return;
  // A maximized or full-screen window is remembered at its normal size.
  const frame = win.getNormalBounds();
  const [width, height] = win.getContentSize();
  const parsed = stateSchema.safeParse({
    version: 1,
    last: {
      x: Math.round(frame.x),
      y: Math.round(frame.y),
      width: Math.round(
        win.isMaximized() || win.isFullScreen() ? frame.width : width,
      ),
      height: Math.round(
        win.isMaximized() || win.isFullScreen() ? frame.height : height,
      ),
    },
  });
  if (!parsed.success) return;
  try {
    writeChatWindowState(file, parsed.data);
  } catch (error) {
    console.error(
      "Conversation window size could not be saved:",
      error instanceof Error ? error.message : error,
    );
  }
}
