import test from "node:test";
import assert from "node:assert/strict";
import { ControlLink } from "../../runner/src/control-link";
import type { CallFrame } from "../../runner/src/dispatcher";
import type { WebAppContext } from "../../runner/src/web-app-context";
import { parseRunnerFrame } from "../../shared/web-runner-frames";
import {
  useElectronShim,
  wsServer,
  type TestSocket,
} from "./runner-core-support.test.ts";

useElectronShim();
const { Dispatcher } = await import("../../runner/src/dispatcher");

async function until(check: () => boolean) {
  const timeout = Date.now() + 5_000;
  while (!check()) {
    assert.ok(Date.now() < timeout, "waiting for runner connection or call");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

for (const scenario of [
  "success",
  "error",
  "old cancel",
  "new cancel",
] as const) {
  test(`reused request ids stay on their connection after ${scenario}`, async (t) => {
    const sockets: TestSocket[] = [];
    const results: {
      connection: number;
      frame: ReturnType<typeof parseRunnerFrame>;
    }[] = [];
    let pongs = 0;
    const server = await wsServer((socket) => {
      const connection = sockets.push(socket);
      socket.onText = (text) => {
        const frame = parseRunnerFrame(text);
        if (frame.t === "hello")
          socket.send(
            JSON.stringify({
              t: "welcome",
              v: 1,
              runnerId: "r-1",
              heartbeatMs: 25_000,
            }),
          );
        if (frame.t === "result") results.push({ connection, frame });
        if (frame.t === "pong") pongs++;
      };
    });
    const started = new Set<number>();
    const completed = new Set<number>();
    const pending = new Map(
      [1, 2].map((userId) => {
        let resolve!: () => void;
        let reject!: (reason?: unknown) => void;
        const promise = new Promise<void>((done, fail) => {
          resolve = done;
          reject = fail;
        });
        return [userId, { promise, resolve, reject }] as const;
      }),
    );
    const calls: Promise<void>[] = [];
    const flushed: number[] = [];
    let engineStops = 0;
    let link: ControlLink;
    const dispatcher = new Dispatcher({
      runtime: {
        serviceUrl: server.url,
        stateDir: "/nonexistent",
        providerServiceScript: "/nonexistent",
        version: "0",
        codexBinary: () => "/bin/false",
      },
      link: {
        send: (frame) => link.send(frame),
        request: (op, userId, body) => link.request(op, userId, body),
      },
      publish: () => {},
      openUrl: () => {},
      flush: (userId) => flushed.push(userId),
      log: () => {},
    });
    for (const userId of [1, 2]) {
      const identity = {};
      dispatcher.contexts.set(userId, {
        userId,
        lastActive: 0,
        tabs: 1,
        signedOut: false,
        setAccessToken() {},
        officialSessionIdentity: () => identity,
        engineRunning: () => true,
        stopEngine: async () => {
          engineStops++;
        },
        handlers: new Map([
          [
            "conversationTurns",
            async () => {
              started.add(userId);
              await pending.get(userId)!.promise;
              completed.add(userId);
              if (scenario === "error" && userId === 1)
                throw new Error("old account read failed");
              return { turns: [{ id: `user-${userId}` }] };
            },
          ],
        ]),
      } as unknown as WebAppContext);
    }
    link = new ControlLink({
      serviceUrl: server.url,
      token: "runner-token-0123456789",
      version: "1",
      methods: () => dispatcher.methods,
      capacity: () => ({ engines: 2, users: 2 }),
      log: () => {},
      random: () => 0,
      handlers: {
        call: (frame) => {
          calls.push(dispatcher.call(frame));
        },
        cancel: (id) => dispatcher.cancel(id),
        down: () => dispatcher.abortRelayedCalls(),
      },
    });
    t.after(async () => {
      for (const call of pending.values()) call.resolve();
      await Promise.all(calls);
      link.stop();
      await server.close();
    });
    const sendCall = (connection: number, userId: number) =>
      sockets[connection - 1]!.send(
        JSON.stringify({
          t: "call",
          id: "c1",
          user: { id: userId, accessToken: `token-${userId}` },
          method: "conversationTurns",
          args: ["conversation"],
          deadlineMs: 120_000,
        } satisfies CallFrame),
      );
    const roundtrip = async (connection: number) => {
      const expected = pongs + 1;
      sockets[connection - 1]!.send(JSON.stringify({ t: "ping" }));
      await until(() => pongs === expected);
    };
    link.start();
    await until(() => link.connected);
    sendCall(1, 1);
    await until(() => started.has(1));
    if (scenario === "old cancel") {
      sockets[0]!.send(JSON.stringify({ t: "cancel", id: "c1" }));
      await roundtrip(1);
    }
    sockets[0]!.close(1001);
    await until(() => sockets.length === 2 && link.connected);
    sendCall(2, 2);
    await until(() => started.has(2));
    if (scenario === "new cancel") {
      sockets[1]!.send(JSON.stringify({ t: "cancel", id: "c1" }));
      await roundtrip(2);
    }
    if (scenario === "old cancel") {
      pending.get(2)!.resolve();
      await calls[1];
      pending.get(1)!.resolve();
    } else {
      pending.get(1)!.resolve();
      await calls[0];
      pending.get(2)!.resolve();
    }
    await Promise.all(calls);
    await roundtrip(2);
    assert.deepEqual(
      [...completed].sort(),
      [1, 2],
      "disconnected calls keep running",
    );
    assert.equal(engineStops, 0, "reconnect does not stop model engines");
    assert.deepEqual(
      results,
      scenario === "new cancel"
        ? []
        : [
            {
              connection: 2,
              frame: {
                t: "result",
                id: "c1",
                ok: true,
                value: { turns: [{ id: "user-2" }] },
              },
            },
          ],
    );
    assert.deepEqual(flushed, scenario === "new cancel" ? [] : [2]);
  });
}
