import assert from "node:assert/strict";
import { test } from "node:test";
import { registerExperimentalCoworkSessions } from "../electron/official-ui/native/cowork-sessions";

test("Cowork folder confirmation is required and scoped to the window and account", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const caller = {};
  let identity = {};
  const selected = new Set(["/chosen", "/second"]);
  let pickerIdentity = identity;
  const trusted = new Set<string>();
  const calls: unknown[][] = [];
  let session: any;
  const host: any = {
    caller,
    hasFolderSelection(window: object, folder: string) {
      return window === caller && pickerIdentity === identity && selected.has(folder);
    },
    ctx: {
      account: () => ({ id: "account" }), sessionIdentity: () => identity,
      onEvent: () => () => {}, localListConversations: async () => session ? [session] : [],
      localLoadConversation: async (id: string) => id === session?.id ? session : undefined,
      settings: () => ({ providers: [{ id: "p", model: "m" }], activeProviderId: "p", mcpServers: {} }),
      localCall: async (name: string, ...args: any[]) => {
        calls.push([name, ...args]);
        if (name === "coworkFolderAccess") {
          if (!selected.has(args[0])) throw Error("Choose the working folder with the folder picker.");
          return { folder: args[0], state: trusted.has(args[0]) ? "trusted" : args[1] && session?.cwd === args[0] ? "granted" : "ask" };
        }
        if (name === "grantCoworkFolder") {
          if (!selected.has(args[0])) throw Error("Choose the working folder with the folder picker.");
          if (args[1] === "always") trusted.add(args[0]);
          return { state: args[1] === "always" ? "trusted" : "granted" };
        }
        if (name === "snapshot") return { approvals: [] };
        if (name === "send") return session = { id: "id", mode: "cowork", cwd: args[0].cwd, turns: [] };
        throw Error(`Unexpected ${name}`);
      },
    },
    on(name: string, fn: (...args: any[]) => any) { handlers.set(name, fn); },
    emit() {},
  };
  registerExperimentalCoworkSessions(host);
  const call = (name: string, ...args: unknown[]) => handlers.get(`LocalAgentModeSessions.${name}`)!(...args);
  const start = (folders: string[]) => call("start", { message: "hello", userSelectedFolders: folders });
  await assert.rejects(start(["/chosen"]), /Allow the selected/);
  await assert.rejects(call("addTrustedFolder", { folder: "/forged", scope: "session" }), /folder picker/);
  assert.equal(await call("isFolderTrusted", "/chosen"), false);
  await call("addTrustedFolder", { folder: "/chosen", scope: "session" });
  host.caller = {};
  await assert.rejects(start(["/chosen"]), /Allow the selected/);
  host.caller = caller;
  await assert.rejects(start(["/chosen", "/second"]), /Only one Cowork folder/);
  assert.deepEqual(await start(["/chosen"]), { sessionId: "local_id" });
  assert.deepEqual((await call("getSession", "local_id")).userSelectedFolders, ["/chosen"]);
  assert.equal((calls.filter(row => row[0] === "send").at(-1)?.[1] as { cwd: string }).cwd, "/chosen");
  assert.ok(calls.some(row => row[0] === "grantCoworkFolder" && row[1] === "/chosen" && row[2] === "session"));
  await assert.rejects(start(["/chosen"]), /Allow the selected/);
  await call("addTrustedFolder", "/second");
  assert.ok(trusted.has("/second"));
  identity = {};
  await assert.rejects(start(["/second"]), /Allow the selected/);
  pickerIdentity = identity;
  assert.equal(await call("isFolderTrusted", "/second"), true);
  await start(["/second"]);
});
