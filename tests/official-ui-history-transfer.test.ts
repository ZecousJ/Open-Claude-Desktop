import test from "node:test";
import assert from "node:assert/strict";
import { registerHistoryTransfer } from "../electron/official-ui/native/history-transfer";

function fixture() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const events: unknown[][] = [],
    calls: unknown[][] = [];
  const window = {};
  let current = true,
    identity = {};
  const host = {
    caller: window,
    ctx: {
      account: () => ({ id: "owner" }),
      sessionIdentity: () => identity,
      isCurrent: () => current,
      localCall: async (...args: unknown[]) => {
        calls.push(args);
        const progress = args[3];
        if (typeof progress === "function") {
          progress("export", "writing", 1, 4);
          progress("import", "registering", 1, 2);
        }
        return { ok: true };
      },
    },
    on: (name: string, handler: (...args: any[]) => any) =>
      handlers.set(name, handler),
    emitTo: (...args: unknown[]) => events.push(args),
  };
  registerHistoryTransfer(host as any);
  return {
    handlers,
    calls,
    events,
    window,
    host,
    retire: () => {
      current = false;
      identity = {};
    },
  };
}

test("native transfer routes use desktop-local account calls and original progress events", async () => {
  const f = fixture();
  assert.deepEqual(f.handlers.get("HistoryImport.getImportCapabilities")!(), {
    remotePull: false,
    remotePullConfigured: false,
    localZip: true,
    localSessions: true,
    sessionExport: true,
    hostLoopRequired: false,
    cliUpdateRequired: false,
    hasImportableSessions: false,
    local1PSessionCount: 0,
    promptBanner: "off",
    showSettingsPage: true,
  });
  await f.handlers.get("ClaudeAiImport.runSessionExport")!(100);
  assert.deepEqual(f.calls[0].slice(0, 3), [
    "officialSessionTransfer",
    "export",
    [100],
  ]);
  assert.deepEqual(f.events, [
    [f.window, "ClaudeAiImport", "onSessionExportProgress", 1, 4],
    [f.window, "HistoryImport", "onImportProgress", "registering", 1, 2],
  ]);
  await f.handlers.get("HistoryImport.importSessionSources")!(10, ["source"]);
  assert.deepEqual(f.calls.at(-1)?.slice(0, 3), [
    "officialSessionTransfer",
    "import",
    [10, ["source"]],
  ]);
  await f.handlers.get("LocalSessions.confirmImportedSessionResume")!(
    "local_session",
  );
  assert.deepEqual(f.calls.at(-1)?.slice(0, 3), [
    "officialSessionTransfer",
    "confirm",
    ["local_session"],
  ]);
  f.retire();
  assert.equal(
    f.handlers.get("HistoryImport.getImportCapabilities")!().sessionExport,
    false,
  );
  await assert.rejects(
    f.handlers.get("LocalSessions.shareSession")!("local_session"),
    /unavailable/,
  );
});

test("native transfer rejects completion after account retirement", async () => {
  const f = fixture();
  f.host.ctx.localCall = async () => {
    f.retire();
    return { ok: true };
  };
  await assert.rejects(
    f.handlers.get("ClaudeAiImport.runSessionExport")!(0),
    /account changed/,
  );
});
