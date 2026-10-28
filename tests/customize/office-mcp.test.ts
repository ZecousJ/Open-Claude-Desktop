import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import {
  OfficeAddinBridge,
  officeTaskpaneScript,
} from "../../electron/connectors/office-addin";
import {
  callOfficeMcp,
  startOfficeMcp,
} from "../../electron/connectors/office-mcp";
import type { OfficeConnectedFile } from "../../shared/office-addin-api";
import type { AppContext } from "../../electron/app/app-context";
import type { EngineExtension } from "../../electron/engine/engine-extensions";
import type { BrowserMcpServerOptions } from "../../electron/browser/mcp-server";

function fixture() {
  const documentId = randomUUID();
  const file = {
    id: documentId,
    addinId: documentId,
    app: "word",
    document: "Notes.docx",
    status: "connected",
    isSelected: true,
    lastConnectedAt: Date.now(),
    lastActivityAt: Date.now(),
  } as OfficeConnectedFile;
  const bridge = new OfficeAddinBridge(() => {});
  Object.assign(bridge, { files: new Map([[documentId, file]]) });
  const command = () =>
    (Reflect.get(bridge, "commands") as Map<string, any[]>)
      .get(documentId)!
      .at(-1);
  return { bridge, file, documentId, command };
}

test("Office MCP replies are document-bound, single-use and cancelled with the account", async () => {
  const { bridge, documentId, command, file } = fixture();
  const controller = new AbortController();
  const read = callOfficeMcp(
    bridge,
    "office_read_selection",
    { documentId },
    controller.signal,
  );
  assert.equal(
    bridge.completeSelection("other", command().requestId, "wrong"),
    false,
  );
  const requestId = command().requestId;
  assert.equal(
    bridge.completeSelection(documentId, requestId, "selected"),
    true,
  );
  assert.equal(await read, "selected");
  assert.equal(
    bridge.completeSelection(documentId, requestId, "replayed"),
    false,
  );
  await assert.rejects(
    callOfficeMcp(
      bridge,
      "office_write_selection",
      { documentId, text: "replace" },
      controller.signal,
    ),
  );
  const revoked = callOfficeMcp(
    bridge,
    "office_read_selection",
    { documentId },
    controller.signal,
  );
  file.isSelected = false;
  bridge.completeSelection(
    documentId,
    command().requestId,
    "no longer selected",
  );
  await assert.rejects(revoked);
  file.isSelected = true;
  const aborted = callOfficeMcp(
    bridge,
    "office_read_selection",
    { documentId },
    controller.signal,
  );
  controller.abort();
  await assert.rejects(aborted);
  const closed = callOfficeMcp(
    bridge,
    "office_read_selection",
    { documentId },
    new AbortController().signal,
  );
  bridge.dispose();
  await assert.rejects(closed);
});

test("the Office taskpane executes selection commands and refuses stale writes", async () => {
  for (const expectedText of ["original", "stale"]) {
    let selected = "original";
    let writes = 0;
    let complete!: (body: any) => void;
    const completed = new Promise<any>((resolve) => {
      complete = resolve;
    });
    const sandbox = vm.createContext({
      location: { hash: "#token" },
      history: { replaceState() {} },
      document: { querySelector: () => ({}) },
      window: { addEventListener() {} },
      setTimeout() {},
      Office: {
        AsyncResultStatus: { Succeeded: "ok" },
        CoercionType: { Text: "text" },
        onReady: (ready: (info: unknown) => Promise<void>) => {
          void ready({ host: "Word" });
        },
        context: {
          document: {
            url: "Notes.docx",
            getSelectedDataAsync: (
              _: unknown,
              done: (result: unknown) => void,
            ) => done({ status: "ok", value: selected }),
            setSelectedDataAsync: (
              text: string,
              _: unknown,
              done: (result: unknown) => void,
            ) => {
              writes++;
              selected = text;
              done({ status: "ok" });
            },
          },
        },
      },
      fetch: async (route: string, options: RequestInit) => {
        const body = JSON.parse(options.body as string);
        assert.equal(
          new Headers(options.headers).get("Authorization"),
          "Bearer token",
        );
        if (route === "/connect") return Response.json({ id: "document" });
        if (route === "/poll")
          return Response.json({
            commands: [
              {
                type: "selection",
                requestId: "request",
                expiresAt: Date.now() + 10000,
                expectedText,
                text: "replacement",
              },
            ],
          });
        assert.equal(route, "/selection-result");
        complete(body);
        return Response.json({});
      },
    });
    vm.runInContext(officeTaskpaneScript, sandbox);
    const result = await completed;
    assert.equal(result.id, "document");
    assert.equal(result.requestId, "request");
    assert.equal(writes, expectedText === "original" ? 1 : 0);
    assert.equal(
      result.text,
      expectedText === "original" ? "replacement" : undefined,
    );
  }
});

test("Office MCP is scoped to non-incognito Cowork, asks approval, and detaches on sign-out", async () => {
  const { bridge } = fixture();
  let extension!: EngineExtension;
  let server!: BrowserMcpServerOptions;
  let removed = false,
    closed = false;
  const conversation = { id: "conversation", mode: "cowork", incognito: false };
  const engine = {
    extensions: {
      add: (entry: EngineExtension) => {
        extension = entry;
        return () => {
          removed = true;
        };
      },
    },
    peerExtensions: [],
  };
  const context = {
    store: { root: "account", conversation: () => conversation },
    policy: () => ({}),
    engine,
    engines: { all: () => [engine] },
  } as unknown as AppContext;
  const stop = await startOfficeMcp(context, bridge, (options) => {
    server = options;
    return {
      start: async () => {},
      url: () => "http://127.0.0.1:1/mcp/capability",
      close: async () => {
        closed = true;
      },
    };
  });
  assert.equal(server.handlers.tools(conversation.id).length, 2);
  const config = extension.builtinMcpServers!({ conversation } as Parameters<
    NonNullable<EngineExtension["builtinMcpServers"]>
  >[0]);
  assert.equal(config?.[0].defaultToolsApprovalMode, "prompt");
  conversation.incognito = true;
  assert.deepEqual(server.handlers.tools(conversation.id), []);
  await stop();
  assert.equal(removed, true);
  assert.equal(closed, true);
  assert.deepEqual(engine.peerExtensions, []);
  bridge.dispose();
});
