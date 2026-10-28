import path from "node:path";
// The default import is read when a window opens, so tests can load this
// file under plain Node (where "electron" is only the binary's path).
import electron from "electron";
import { z } from "zod";
import type { AppContext, IpcHandle } from "../app/app-context";
import type { AppCommand } from "../../shared/types";
import type { WindowHandoff } from "../../shared/windows-api";
import { ChatWindows, type CheckedHandoff } from "../app/chat-windows";
import { reportMenuState } from "../app/menu-state";
import { toolPaneKinds } from "../../shared/tool-pane";
import {
  openLayoutSchema,
  sessionPopoutSchema,
  layoutResultSchema,
} from "../app/window-layout-input";
import { WindowLayoutCommands } from "../app/window-layout";
import type { LayoutCommand } from "../../shared/window-layout";

declare module "../app/app-context" {
  /** R2-B: the separate conversation windows, for other packages (notifications, menus). */
  interface ChatWindowsSlot {
    layoutCommand?(
      command: Omit<
        LayoutCommand,
        "requestId" | "deadline" | "mainWindowHidden"
      >,
    ): Promise<import("../app/window-layout").LayoutDispatchResult>;
    /** Opens (or focuses) a conversation's own window. */
    openConversation(conversationId: string): Promise<void>;
    /** Focuses the conversation's window; false when it has none. */
    focusConversation(conversationId: string): boolean;
    /** Conversations open in separate windows now. */
    conversationIds(): string[];
    /** The conversation a separate window shows; undefined for any other window. */
    conversationOf?(win: unknown): string | undefined;
    preserveLayout?(): void;
    /** Brings the main window forward. */
    showMain(event: {
      type: "command";
      command: AppCommand;
      conversationId?: string;
    }): boolean;
  }
}

/** The account's conversation windows as the app runs them. */
export function chatWindowsFor(ctx: AppContext) {
  const { BrowserWindow, nativeTheme, screen } = electron;
  return new ChatWindows({
    createWindow: (options) => new BrowserWindow(options),
    windows: ctx.appWindows,
    push: (event) => ctx.push(event),
    workAreas: () => {
      const primary = screen.getPrimaryDisplay();
      return [
        primary.workArea,
        ...screen
          .getAllDisplays()
          .filter((display) => display.id !== primary.id)
          .map((display) => display.workArea),
      ];
    },
    statePath: () => path.join(ctx.dataRoot, "chat-windows.json"),
    layoutPath: () =>
      ctx.activeAccount
        ? path.join(ctx.store.root, "session-popouts.json")
        : undefined,
    platform: process.platform,
    dark: () => {
      const theme = ctx.activeAccount ? ctx.store.settings.theme : "system";
      return (
        theme === "dark" ||
        (theme === "system" && nativeTheme.shouldUseDarkColors)
      );
    },
    conversation: (id) =>
      ctx.activeAccount
        ? ctx.store.conversations.find((c) => c.id === id)
        : undefined,
    project: (id) =>
      ctx.activeAccount
        ? ctx.store.projects.find((project) => project.id === id)
        : undefined,
  });
}

/** Commands a separate window hands to the main window. */
const forwardedCommand = z.enum([
  "new-chat",
  "incognito",
  "search",
  "search-palette",
  "area-chat",
  "area-code",
  "settings",
  "toggle-sidebar",
  "shortcuts",
  "back",
  "forward",
  "open-folder",
  "open-file",
  "reopen-closed-session",
]);
const conversationId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const handoffSchema = z
  .object({
    text: z.string().max(200000),
    attachmentIds: z.array(z.string().min(1).max(500)).max(12),
    providerId: z.string().min(1).max(100).optional(),
    model: z.string().min(1).max(200).optional(),
    webSearch: z.boolean().optional(),
  })
  .strip();

/**
 * Separate conversation windows (R2, shared/windows-api.ts). Any app window
 * may open one; the window-only calls act on the calling window itself and
 * answer "none" from the main window, so one window never drives another.
 * `create` replaces the window manager in tests.
 */
export function registerWindowsHandlers(
  handle: IpcHandle,
  ctx: AppContext,
  create: (ctx: AppContext) => ChatWindows = chatWindowsFor,
) {
  let manager: ChatWindows | undefined;
  const layoutCommands = new WindowLayoutCommands();
  // Created on first use: the displays and the profile exist only once the app is ready.
  const windows = () => {
    manager ??= create(ctx);
    return manager;
  };
  if (ctx.services)
    ctx.services.chatWindows = {
      layoutCommand: (command) => {
        const main = ctx.appWindows.main();
        return layoutCommands.dispatch(
          main?.webContents,
          command,
          !main ||
            main.isDestroyed() ||
            main.isMinimized() ||
            !main.isVisible(),
          (command) => {
            if (main)
              ctx.appWindows.send(main, { type: "layout-command", command });
          },
        );
      },
      openConversation: (id) => windows().openConversation(id),
      focusConversation: (id) => windows().focusConversation(id),
      conversationIds: () => manager?.conversationIds() ?? [],
      preserveLayout: () => manager?.preserveLayout(),
      conversationOf: (win) =>
        manager?.conversationOf(
          win as Parameters<ChatWindows["conversationOf"]>[0],
        ),
      showMain: (event) => windows().showMain(event),
    };

  // A draft handed back to the main window must not reach the next account.
  ctx.onAccountActivated?.(() => {
    void windows().restoreLayout();
  });
  ctx.onAccountDeactivating?.(() => {
    layoutCommands.dispose();
    manager?.preserveLayout();
    manager?.dropHandoffs();
    manager?.closeAll();
    manager = undefined;
  });
  const mainCaller = () => {
    const caller = ctx.callerWindow();
    return caller && caller === ctx.appWindows.main() ? caller : undefined;
  };
  handle("openProjectWindow", async (raw: unknown) =>
    windows().openProject(conversationId.parse(raw)),
  );
  handle(
    "windowLayoutState",
    async () =>
      manager?.layoutState() ?? {
        popoutSessionIds: [],
        visibleSessionIds: [],
        otherPopoutCount: 0,
      },
  );
  handle("reportOpenLayout", async (raw: unknown) => {
    if (mainCaller()) windows().reportOpenLayout(openLayoutSchema.parse(raw));
  });
  handle("reportOpenPopouts", async (raw: unknown) => {
    if (mainCaller())
      windows().reportOpenLayout({
        popouts: z.array(sessionPopoutSchema).max(50).parse(raw),
        panes: [],
      });
  });
  handle("takeRestorableLayout", async () =>
    mainCaller() ? windows().takeRestorableLayout() : null,
  );
  handle("takeRestorablePopouts", async () => {
    const layout = mainCaller() ? windows().takeRestorableLayout() : null;
    return layout?.popouts.length ? layout.popouts : null;
  });
  handle("setLayoutCommandListening", async (raw: unknown) => {
    const caller = mainCaller();
    if (caller)
      layoutCommands.setListening(caller.webContents, z.boolean().parse(raw));
  });
  handle("reportLayoutCommandResult", async (raw: unknown) => {
    const caller = mainCaller();
    if (caller)
      layoutCommands.report(caller.webContents, layoutResultSchema.parse(raw));
  });

  /** A draft whose attachments the person chose in this session. */
  const checkedHandoff = (raw: unknown): CheckedHandoff | undefined => {
    if (raw === undefined || raw === null) return undefined;
    const handoff: WindowHandoff = handoffSchema.parse(raw);
    const attachments = handoff.attachmentIds.map((id) => {
      const found = ctx.selectedAttachments.get(id);
      if (!found)
        throw new Error(
          "An attachment is no longer available. Remove it and add it again.",
        );
      return found;
    });
    return { ...handoff, attachments };
  };
  /** The calling window when it is a separate conversation window. */
  const callerChatWindow = () => {
    // No separate window exists before the first one opens.
    const caller = manager && ctx.callerWindow();
    return caller && manager?.conversationOf(caller) ? caller : undefined;
  };

  handle(
    "openConversationWindow",
    async (id: unknown, handoff: unknown, rawOptions: unknown) =>
      windows().openConversation(
        conversationId.parse(id),
        checkedHandoff(handoff),
        undefined,
        undefined,
        z
          .object({ showInactive: z.boolean().optional() })
          .optional()
          .parse(rawOptions)?.showInactive,
      ),
  );
  handle("openToolPaneWindow", async (id: unknown, pane: unknown) =>
    windows().openConversation(
      conversationId.parse(id),
      undefined,
      z.enum(toolPaneKinds).parse(pane),
    ),
  );
  handle("returnToMainWindow", async (handoff: unknown) => {
    const caller = callerChatWindow();
    if (!caller)
      throw new Error("This window isn't a separate conversation window.");
    windows().returnToMain(caller, checkedHandoff(handoff));
  });
  handle("setWindowPinned", async (on: unknown) => {
    const caller = ctx.callerWindow();
    return caller ? windows().setPinned(caller, z.boolean().parse(on)) : false;
  });
  handle("getWindowPinned", async () => {
    const caller = ctx.callerWindow();
    return (
      !!caller &&
      !!manager?.windowOf(caller.webContents) &&
      caller.isAlwaysOnTop()
    );
  });
  handle("takeWindowHandoff", async () =>
    manager ? manager.takeHandoff(ctx.callerWindow()) : null,
  );
  handle("reportWindowVisibility", async (visible: unknown) => {
    const caller = callerChatWindow();
    if (caller) windows().reportVisibility(caller, z.boolean().parse(visible));
  });
  handle("forwardToMainWindow", async (raw: unknown) => {
    // Only a separate window forwards; the main window runs its own commands.
    if (!callerChatWindow()) return;
    const command = z
      .union([
        forwardedCommand,
        z.object({ openConversation: conversationId }).strict(),
      ])
      .parse(raw);
    if (typeof command === "string") {
      windows().showMain({ type: "command", command });
      return;
    }
    const target = ctx.activeAccount
      ? ctx.store.conversations.find(
          (c) => c.id === command.openConversation && !c.incognito,
        )
      : undefined;
    if (!target) throw new Error("This conversation isn't available.");
    // A conversation with its own window is shown there, not twice.
    if (windows().focusConversation(target.id)) return;
    windows().showMain({
      type: "command",
      command: "open-conversation",
      conversationId: target.id,
    });
  });
  handle("conversationWindows", async () => manager?.conversationIds() ?? []);
  // The application menu follows the main window only.
  handle("reportMenuState", async (state: unknown) => {
    if (!mainCaller()) return;
    reportMenuState(state);
  });
}
