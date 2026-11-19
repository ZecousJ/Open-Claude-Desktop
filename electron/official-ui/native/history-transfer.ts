import type { NativeHost } from "./host";
import { unavailableHistoryTransferCapabilities } from "./history-transfer-capabilities";
import { sessionAccountScope } from "./session-account-scope";

export function registerHistoryTransfer(host: NativeHost) {
  const { ctx } = host;
  const scope = sessionAccountScope(ctx, () => {});
  const available = () =>
    !!ctx.account()?.id &&
    !!ctx.localCall &&
    !ctx.readOnly &&
    ctx.isCurrent?.() !== false;
  host.on("HistoryImport.getImportCapabilities", (...args: unknown[]) => {
    if (args.length)
      throw Error("History import capabilities takes no arguments.");
    const enabled = available();
    return {
      ...unavailableHistoryTransferCapabilities(),
      localSessions: enabled,
      localZip: enabled,
      sessionExport: enabled,
      showSettingsPage: enabled,
    };
  });
  const operations: Record<string, string> = {
    "ClaudeAiImport.previewSessionExport": "preview",
    "ClaudeAiImport.runSessionExport": "export",
    "ClaudeAiImport.cancelSessionExport": "cancelExport",
    "ClaudeAiImport.showExportInFolder": "showExport",
    "ClaudeAiImport.pickLocalZips": "pickZips",
    "ClaudeAiImport.peekLocalZips": "peek",
    "ClaudeAiImport.registerDesktop3pBundle": "registerBundle",
    "ClaudeAiImport.pickSessionSourceFolder": "pickFolder",
    "ClaudeAiImport.confirmImportedSessionResume": "confirm",
    "LocalSessions.confirmImportedSessionResume": "confirm",
    "HistoryImport.enumerateSessionSources": "enumerate",
    "HistoryImport.scanSessionSource": "scan",
    "HistoryImport.importSessionSources": "import",
    "HistoryImport.getImportHistory": "history",
    "HistoryImport.getRemovePreview": "removePreview",
    "HistoryImport.removeImportRun": "remove",
    "LocalSessions.shareSession": "share",
  };
  for (const [method, operation] of Object.entries(operations))
    host.on(method, (...args: unknown[]) =>
      scope.run(async () => {
        if (!available())
          throw Error("Session transfer is unavailable for this account.");
        const window = host.caller;
        const progress = (
          kind: string,
          phase: string,
          done: number,
          total: number,
        ) => {
          if (!window) return;
          if (kind === "export")
            host.emitTo(
              window,
              "ClaudeAiImport",
              "onSessionExportProgress",
              done,
              total,
            );
          else
            host.emitTo(
              window,
              "HistoryImport",
              "onImportProgress",
              phase,
              done,
              total,
            );
        };
        return scope.guard(() =>
          ctx.localCall!("officialSessionTransfer", operation, args, progress),
        );
      }),
    );
  host.on("HistoryImport.removeAllImportRuns", () =>
    scope.run(() => {
      if (!available())
        throw Error("Session transfer is unavailable for this account.");
      return scope.guard(() =>
        ctx.localCall!("officialSessionTransfer", "remove", ["*"]),
      );
    }),
  );
}
