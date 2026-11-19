import type { BrowserWindow } from "electron";
import { z } from "zod";
import type { SessionPopouts } from "../../app/session-popouts";
import type { WindowLayoutCommands } from "../../app/window-layout";
import {
  layoutResultSchema,
  openLayoutSchema,
} from "../../app/window-layout-input";
import type { OpenLayout } from "../../../shared/window-layout";
import type { NativeHost } from "./host";

export interface WindowLayoutIntegration {
  mainWindow(): BrowserWindow | undefined;
  sessions(
    window: BrowserWindow,
  ): Pick<SessionPopouts, "report" | "take"> | undefined;
  commands(
    window: BrowserWindow,
  ): Pick<WindowLayoutCommands, "setListening" | "report"> | undefined;
}

const accountUuidSchema = z.string().min(1).max(36).optional();
const layoutReportSchema = openLayoutSchema.safeExtend({
  accountUuid: accountUuidSchema,
});
const listeningSchema = z.boolean();

function hasOpenWindows(layout: OpenLayout) {
  return Boolean(
    layout.popouts.length || layout.panes.length || layout.projects?.length,
  );
}

export function registerWindowLayout(
  host: NativeHost,
  integration: WindowLayoutIntegration,
) {
  const mainCaller = () => {
    const caller = host.caller;
    return caller && caller === integration.mainWindow() ? caller : undefined;
  };
  const sessionsFor = (window: BrowserWindow, accountUuid?: string) => {
    const owner = host.ctx.account()?.id;
    if (owner && (accountUuid === undefined || accountUuid === owner))
      return integration.sessions(window);
  };

  host.on("SessionPopouts.reportOpenLayout", (raw: unknown) => {
    const caller = mainCaller();
    if (!caller) return;
    const { accountUuid, ...layout } = layoutReportSchema.parse(raw);
    // Renderer teardown can send an empty report without the account UUID.
    if (
      accountUuid === undefined &&
      !hasOpenWindows(layout) &&
      !layout.handledPanes?.length &&
      !layout.handledProjects?.length
    )
      return;
    sessionsFor(caller, accountUuid)?.report(layout);
  });
  host.on("SessionPopouts.reportOpenPopouts", (raw: unknown) => {
    const caller = mainCaller();
    if (!caller) return;
    const popouts = openLayoutSchema.shape.popouts.parse(raw);
    sessionsFor(caller)?.report({ popouts, panes: [] });
  });
  host.on("SessionPopouts.takeRestorableLayout", (raw: unknown) => {
    const caller = mainCaller();
    if (!caller) return null;
    const layout = sessionsFor(caller, accountUuidSchema.parse(raw))?.take();
    return layout && hasOpenWindows(layout) ? layout : null;
  });
  host.on("SessionPopouts.takeRestorablePopouts", () => {
    const caller = mainCaller();
    const layout = caller && sessionsFor(caller)?.take();
    return layout?.popouts.length ? layout.popouts : null;
  });
  host.on("WindowLayout.setLayoutCommandListening", (raw: unknown) => {
    const caller = mainCaller();
    if (caller)
      integration
        .commands(caller)
        ?.setListening(caller.webContents, listeningSchema.parse(raw));
  });
  host.on("WindowLayout.reportLayoutCommandResult", (raw: unknown) => {
    const caller = mainCaller();
    if (caller)
      integration
        .commands(caller)
        ?.report(caller.webContents, layoutResultSchema.parse(raw));
  });
}
