import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { desktopCredentialStorage } from "../electron/account/desktop-credential-storage";
import { Engine } from "../electron/engine/engine";
import {
  newConversation,
  type SendInput,
} from "../electron/engine/new-conversation";
import { registerConversationTurnHandlers } from "../electron/ipc/conversation-turn-handlers";
import { registerCodeSessionEnvironment } from "../electron/official-ui/native/code-session-environment";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";
import type { NativeHandler } from "../electron/official-ui/native/host";
import { Store } from "../electron/store/store";

test("native Code saves scope credentials privately and starts a session with independent scope and preset IDs", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-code-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { cipher } = desktopCredentialStorage(root, "darwin", {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw Error("Unexpected OS encryption");
    },
    decryptString: () => {
      throw Error("Unexpected OS decryption");
    },
  });
  const accountRoot = path.join(root, "account");
  let store = new Store(accountRoot, cipher);
  const provider = store.settings.providers[0];
  const account = { id: "scope-owner" };
  const handlers = new Map<string, NativeHandler>();
  const ipc = new Map<string, NativeHandler>();
  const context = {
    accountActivationIdentity: {},
    accountRetiring: false,
    activeAccount: account,
    get store() {
      return store;
    },
    engine: {
      send: (input: SendInput) => {
        const session = newConversation(input, provider, root, store.settings);
        store.conversations.push(session);
        store.flush();
        return session;
      },
    },
    selectedAttachments: new Map(),
    allowedFolder: () => {},
  };
  registerConversationTurnHandlers({
    context,
    handle: (method: string, handler: NativeHandler) =>
      ipc.set(method, handler),
  } as never);
  const host = {
    ctx: {
      account: () => account,
      sessionIdentity: () => store,
      codeSessionEnvironmentStore: () => store,
      stateDirectory: () => store.root,
      settings: () => store.settings,
      localLoadConversation: async (id: string) =>
        store.conversations.find((row) => row.id === id),
      localListConversations: async () => store.conversations,
      localCall: async (method: string, ...args: unknown[]) =>
        method === "snapshot" ? { approvals: [] } : ipc.get(method)!(...args),
      onEvent: () => () => {},
      log: () => {},
    },
    on: (method: string, handler: NativeHandler) =>
      handlers.set(method, handler),
    emit: () => {},
  };
  registerCodeSessionEnvironment(host as never);
  t.after(registerExperimentalCodeSessions(host as never));
  const call = (method: string, ...args: unknown[]) =>
    handlers.get(method)!(...args);
  const submitted = {
    F107_SCOPE_MARKER: "a-long-test-value",
    F107_SHORT: "short",
  };
  assert.deepEqual(
    call("LocalSessionEnvironment.saveScoped", "scope", submitted),
    { success: true },
  );
  assert.deepEqual(
    call("LocalSessionEnvironment.saveScoped", "preset", {
      F107_SCOPE_MARKER: "other",
    }),
    { success: true },
  );
  const mask = { F107_SCOPE_MARKER: "a-long-tes...alue", F107_SHORT: "••••••" };
  assert.deepEqual(call("LocalSessionEnvironment.getScoped", "scope"), mask);
  call("LocalSessionEnvironment.saveScoped", "scope", mask);
  const requestedId = "a93e1c2f-bd30-4fc8-80aa-779f729d8aa7";
  const sessionId = "local_" + requestedId;
  assert.deepEqual(
    await call("LocalSessions.start", {
      sessionId,
      cwd: root,
      message: "Read the scope marker",
      model: "model",
      envScopeId: "scope",
      startedFromEnvironmentId: "preset",
    }),
    { sessionId },
  );
  store = new Store(accountRoot, cipher);
  const session = store.conversation(requestedId);
  assert.equal(session.envScopeId, "scope");
  assert.partialDeepStrictEqual(
    await call("LocalSessions.getSession", sessionId),
    { startedFromEnvironmentId: "preset" },
  );
  assert.partialDeepStrictEqual(await call("LocalSessions.getSessionList"), {
    sessions: [{ startedFromEnvironmentId: "preset" }],
  });
  assert.deepEqual(call("LocalSessionEnvironment.getScoped", "scope"), mask);
  assert.equal(
    fs
      .readFileSync(
        path.join(accountRoot, "code-session-environment.json"),
        "utf8",
      )
      .includes(submitted.F107_SCOPE_MARKER),
    false,
  );
  assert.equal(
    fs
      .readFileSync(path.join(accountRoot, "conversations.json"), "utf8")
      .includes(submitted.F107_SCOPE_MARKER),
    false,
  );

  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  const scopeConfig = () =>
    engine.threadOptions(session, provider, session.model, "code").config[
      "shell_environment_policy.set"
    ];
  assert.deepEqual(scopeConfig(), submitted);
  assert.deepEqual(call("LocalSessionEnvironment.removeScoped", "scope"), {
    success: true,
  });
  assert.deepEqual(scopeConfig(), {});
  store = new Store(path.join(root, "other-account"), cipher);
  assert.deepEqual(call("LocalSessionEnvironment.getScoped", "preset"), {});
});
