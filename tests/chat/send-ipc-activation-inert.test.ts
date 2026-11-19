/** Real handler and registry binding; no Engine, SSH launcher or SDK is started. */
import test from "node:test";
import assert from "node:assert/strict";
import { registerConversationTurnHandlers } from "../../electron/ipc/conversation-turn-handlers";
import { EngineRegistry } from "../../electron/engine/engine-registry";
for (const ssh of [false, true])
  for (const retire of [false, true])
    test(`send ${ssh ? "SSH" : "local"} ${retire ? "retires pending result" : "preserves valid dispatch"}`, async () => {
      const handlers = new Map<string, (...args: any[]) => any>();
      let finish!: (c: any) => void;
      let options: any;
      let input: any;
      const conversation = { id: "c", mode: ssh ? "code" : "chat", turns: [] };
      const engine: any = {
        send: async (i: any, _x: any, _y: any, o: any) => {
          input = i;
          options = o;
          return new Promise((r) => {
            finish = r;
          });
        },
      };
      const context: any = {
        accountActivationIdentity: {},
        accountRetiring: false,
        activeAccount: { id: "a" },
        engine,
        store: {
          root: "/inert-send-no-io",
          projects: [],
          conversation: () => undefined,
        },
        selectedAttachments: new Map(),
        allowedFolder: () => {},
      };
      const registry = ssh ? new EngineRegistry(() => engine) : undefined;
      const off = registry?.bind({
        ssh: () => undefined,
        dataRoot: "/inert-send-no-io",
        onEvent: () => () => {},
        allowedFolder: () => {},
      });
      registerConversationTurnHandlers({
        context,
        handle: (n: string, f: (...a: any[]) => any) => handlers.set(n, f),
        cli: {},
        resumable: {},
      } as any);
      try {
        const pending = handlers.get("send")!({
          text: "inert",
          mode: ssh ? "code" : "chat",
          attachments: [],
          providerId: "p",
          model: "m",
          ...(ssh
            ? { environment: { kind: "ssh", hostId: "host" }, cwd: "/picked" }
            : {}),
        });
        assert.equal(options.current(), true);
        assert.equal(input.text, "inert");
        if (retire) {
          context.accountActivationIdentity = {};
          assert.equal(options.current(), false);
        }
        finish(conversation);
        if (retire) await assert.rejects(pending, /account changed/i);
        else assert.equal(await pending, conversation);
      } finally {
        off?.();
      }
    });
