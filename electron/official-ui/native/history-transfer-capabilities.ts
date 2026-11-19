import type { NativeHost } from "./host";

/** Original 4.4212.0 disabled transfer contract. CLI import has its own methods.
 * A transcript ZIP is not a compatible account/session migration bundle.
 * Keep these capabilities off until its format, picker and account scope exist.
 */
export function unavailableHistoryTransferCapabilities() {
  return {
    remotePull: false,
    remotePullConfigured: false,
    localZip: false,
    localSessions: false,
    sessionExport: false,
    hostLoopRequired: false,
    cliUpdateRequired: false,
    hasImportableSessions: false,
    local1PSessionCount: 0,
    promptBanner: "off",
  };
}

export function registerHistoryTransferCapabilities(host: NativeHost) {
  host.on("HistoryImport.getImportCapabilities", (...args: unknown[]) => {
    if (args.length)
      throw Error("History import capabilities takes no arguments.");
    return unavailableHistoryTransferCapabilities();
  });
}
