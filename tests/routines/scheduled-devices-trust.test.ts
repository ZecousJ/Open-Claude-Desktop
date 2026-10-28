import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, webcrypto } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeviceTrustStore } from "../../electron/remote-control/device-trust-store";
import { DesktopDeviceTrustClient } from "../../electron/remote-control/device-trust-client";
import { BrowserDeviceTrustClient } from "../../src-web/bridge/device-trust-client";
import { CoworkDevices } from "../../src-web/bridge/cowork-devices";
import { WebTransport } from "../../shared/web-client/transport";
import {
  DeviceLink,
  type LinkSocket,
} from "../../electron/remote-control/device-link";
import type { DeviceMethods } from "../../electron/remote-control/device-methods";
import {
  deviceTrustMessage,
  type DeviceMethod,
  type DeviceTrustChallenge,
  type DeviceTrustEnvelope,
} from "../../shared/remote-devices";
import type { Snapshot } from "../../shared/types";

const hostId = "pc-real-host";
const scope = "https://service.example:account-a";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function temporary() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claudex-b31-trust-"));
}
function signer() {
  const keys = generateKeyPairSync("ed25519");
  const identity = {
    publicKey: keys.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    name: "Browser",
    platform: "macOS",
  };
  const envelope = (
    challenge: DeviceTrustChallenge,
    method: string,
    args: unknown[],
  ): DeviceTrustEnvelope => ({
    deviceTrust: {
      challengeId: challenge.id,
      signature: sign(
        null,
        Buffer.from(deviceTrustMessage(challenge, method, args)),
        keys.privateKey,
      ).toString("base64"),
    },
    args,
  });
  return { identity, envelope };
}
async function relay(directory: string) {
  let now = Date.parse("2026-10-19T00:00:00Z");
  let trust = new DeviceTrustStore(directory, scope, hostId, () => now);
  const calls: [string, unknown[]][] = [];
  let opened = {
    conversation: { id: "task", turns: [], mode: "cowork", updatedAt: 1 },
    approvals: [],
  } as unknown;
  const broadcasts: unknown[] = [];
  let delay: (() => Promise<void>) | undefined;
  const waiting = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  let next = 0;
  const socket: LinkSocket = {
    readyState: 1,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    close() {},
    send(data) {
      const frame = JSON.parse(data);
      if (frame.t === "event") broadcasts.push(frame.event);
      if (frame.t !== "result") return;
      const pending = waiting.get(frame.id)!;
      waiting.delete(frame.id);
      if (frame.ok) pending.resolve(frame.value);
      else pending.reject(new Error(frame.error.message));
    },
  };
  const link = new DeviceLink({
    baseUrl: () => "https://service.example",
    session: () =>
      ({
        currentToken: async () => "authenticated-account-token",
        renewed: async () => "renewed",
      }) as never,
    enabled: () => true,
    linkId: () => hostId,
    name: () => "Studio",
    platform: "darwin",
    version: "1",
    trustStore: () => trust,
    methods: {
      call: async (method: string, args: unknown[]) => {
        calls.push([method, args]);
        if (delay) await delay();
        return method === "openConversation" ? opened : { accepted: true };
      },
      chatDevices: { capabilities: () => ({}) },
      eventsFor: () => [
        {
          type: "approval",
          approval: { id: "secret", conversationId: "task" },
        },
      ],
      forget() {},
    } as unknown as DeviceMethods,
    fetch: (async () =>
      new Response(
        JSON.stringify({
          code: 0,
          data: { ticket: "A".repeat(43), expires_in: 30 },
        }),
      )) as typeof fetch,
    openSocket: () => socket,
    setTimeout: () => 1,
    clearTimeout() {},
    now: () => now,
  });
  link.refresh();
  await tick();
  await tick();
  socket.onopen?.({});
  socket.onmessage?.({ data: JSON.stringify({ t: "welcome" }) });
  const raw = (method: DeviceMethod, args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      const id = `request-${++next}`;
      waiting.set(id, { resolve, reject });
      // Round trip opaque JSON args exactly as the existing Go relay does.
      socket.onmessage?.({
        data: JSON.stringify({
          t: "call",
          id,
          method,
          args: JSON.parse(JSON.stringify(args)),
        }),
      });
    });
  return {
    link,
    raw,
    calls,
    broadcasts,
    setDelay: (value: () => Promise<void>) => {
      delay = value;
    },
    setOpened: (value: unknown) => {
      opened = value;
    },
    trust: () => trust,
    advance: (ms: number) => {
      now += ms;
    },
    reload: () => {
      trust = new DeviceTrustStore(directory, scope, hostId, () => now);
    },
    otherAccount: () => {
      trust = new DeviceTrustStore(
        directory,
        "https://service.example:account-b",
        hostId,
        () => now,
      );
      trust.setRequired(true);
    },
  };
}

test("actual DeviceLink denies self-asserted trust, replay, forged methods/args, expired proofs and wrong accounts", async () => {
  const directory = temporary();
  const env = await relay(directory);
  try {
    env.trust().setRequired(true);
    await assert.rejects(
      env.raw("send", [
        { trusted: true, clientId: "approved", text: "unsafe" },
      ]),
      /Verify/,
    );
    const client = signer();
    const enroll = env.trust().challenge(client.identity);
    await assert.rejects(
      env.raw("deviceTrustEnroll", [
        {
          ...client.envelope(enroll, "deviceTrustEnroll", []),
          deviceTrust: {
            challengeId: enroll.id,
            signature: "A".repeat(86) + "==",
          },
        },
      ]),
      /Verify/,
    );
    const pending = (await env.raw("deviceTrustEnroll", [
      client.envelope(
        env.trust().challenge(client.identity),
        "deviceTrustEnroll",
        [],
      ),
    ])) as { status: string };
    assert.equal(pending.status, "pending");
    assert.equal(env.trust().state().trusted.length, 0);
    const requested = env.trust().state().pending[0];
    assert.throws(
      () => env.trust().approve(requested.id, "self-asserted"),
      /expired/,
    );
    env.trust().approve(requested.id, requested.fingerprint);
    const proof = client.envelope(
      env.trust().challenge(client.identity),
      "send",
      [{ text: "safe" }],
    );
    assert.deepEqual(await env.raw("send", [proof]), { accepted: true });
    await assert.rejects(env.raw("send", [proof]), /Verify/);
    const mutated = client.envelope(
      env.trust().challenge(client.identity),
      "send",
      [{ text: "safe" }],
    );
    mutated.args = [{ text: "changed" }];
    await assert.rejects(env.raw("send", [mutated]), /Verify/);
    await assert.rejects(
      env.raw("interrupt", [
        client.envelope(env.trust().challenge(client.identity), "send", []),
      ]),
      /Verify/,
    );
    const expired = client.envelope(
      env.trust().challenge(client.identity),
      "send",
      [],
    );
    env.advance(120_001);
    await assert.rejects(env.raw("send", [expired]), /Verify/);
    const crossAccount = client.envelope(
      env.trust().challenge(client.identity),
      "send",
      [],
    );
    env.otherAccount();
    await assert.rejects(env.raw("send", [crossAccount]), /Verify/);
    assert.equal(env.calls.length, 1);
  } finally {
    env.link.disconnect();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("desktop client enrolls through real DeviceLink, persists trust and revocation survives restart", async () => {
  const directory = temporary();
  const env = await relay(directory);
  const client = new DesktopDeviceTrustClient(
    () => directory,
    () => scope,
    () => "Desktop",
    "darwin",
  );
  try {
    env.trust().setRequired(true);
    await assert.rejects(
      client.call(env.raw, hostId, "send", [{ text: "first" }]),
      /Approve this device/,
    );
    assert.equal(env.calls.length, 0);
    const pending = env.trust().state().pending[0];
    env.trust().approve(pending.id, pending.fingerprint);
    env.reload();
    assert.equal(env.trust().state().requireTrustedDevices, true);
    await client.call(env.raw, hostId, "send", [{ text: "approved" }]);
    assert.equal(env.calls.length, 1);
    assert.ok(env.trust().state().trusted[0].lastSeenAt);
    env.trust().revoke(pending.id);
    env.reload();
    await assert.rejects(client.call(env.raw, hostId, "send", []), /revoked/);
    assert.equal(env.calls.length, 1);
    assert.equal(env.trust().state().trusted.length, 0);
    for (const file of fs.readdirSync(directory))
      assert.equal(fs.statSync(path.join(directory, file)).mode & 0o777, 0o600);
  } finally {
    env.link.disconnect();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("browser Cowork uses authenticated transport and signed DeviceLink calls after local approval", async () => {
  const directory = temporary();
  const env = await relay(directory);
  const oldCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto,
  });
  let account: string | undefined = scope;
  const pair = (await webcrypto.subtle.generateKey("Ed25519", false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const browser = new BrowserDeviceTrustClient(
    () => account,
    "macOS",
    async () => pair,
  );
  let authenticated = 0;
  const transport = new WebTransport(
    {
      fetch: (async (url, init) => {
        assert.equal(
          new Headers(init?.headers).get("Authorization"),
          "Bearer browser-account-token",
        );
        authenticated++;
        const route = String(url);
        if (!init?.body)
          return new Response(
            JSON.stringify({
              ok: true,
              value: [{ id: hostId, online: true, computerAccess: true }],
            }),
          );
        const method = route.split("/").at(-1) as DeviceMethod;
        try {
          return new Response(
            JSON.stringify({
              ok: true,
              value: await env.raw(method, JSON.parse(String(init.body)).args),
            }),
          );
        } catch (error) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: { message: (error as Error).message },
            }),
          );
        }
      }) as typeof fetch,
      timers: {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
        setInterval,
        clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
      },
    },
    {
      accessToken: async () => "browser-account-token",
      refresh: async () => null,
      expire() {},
    },
    "tab-authenticated",
  );
  const polling = new Map<number, () => void>();
  let timerId = 0;
  const emitted: import("../../shared/types").AppEvent[] = [];
  const devices = new CoworkDevices(
    transport,
    (event) => emitted.push(event),
    browser,
    {
      set: (callback, ms) => {
        assert.equal(ms, 3000);
        const id = ++timerId;
        polling.set(id, callback);
        return id;
      },
      clear: (id) => {
        polling.delete(id as number);
      },
    },
  );
  const poll = async () => {
    const [id, callback] = polling.entries().next().value!;
    polling.delete(id);
    callback();
    await devices.refresh();
    await tick();
  };
  const snapshot = {
    conversations: [
      {
        id: "task",
        mode: "cowork",
        linkedToComputer: true,
        linkedComputerId: hostId,
        environment: { kind: "space", spaceId: "r" },
      },
    ],
    approvals: [],
  } as unknown as Snapshot;
  try {
    env.trust().setRequired(true);
    await devices.snapshot(snapshot);
    assert.equal(env.calls.length, 0);
    const pending = env.trust().state().pending[0];
    assert.equal(pending.name, "Web browser");
    env.trust().approve(pending.id, pending.fingerprint);
    await devices.snapshot(snapshot);
    assert.equal(env.calls[0][0], "openConversation");
    assert.ok(authenticated >= 7);
    env.link.observe({
      type: "approval",
      approval: { id: "secret", conversationId: "task" },
    } as never);
    assert.deepEqual(env.broadcasts, []);
    assert.equal(polling.size, 1);
    env.setOpened({
      conversation: {
        id: "task",
        title: "Updated by signed polling",
        turns: [],
        updatedAt: 2,
      },
      approvals: [{ id: 7, conversationId: "task" }],
    });
    await poll();
    assert.ok(
      emitted.some(
        (event) =>
          event.type === "conversation" &&
          event.conversation.title === "Updated by signed polling",
      ),
    );
    assert.ok(
      emitted.some(
        (event) =>
          event.type === "approval" &&
          event.approval.id === `cowork-device:${hostId}:7`,
      ),
    );
    env.setOpened({
      conversation: { id: "task", title: "Completed", turns: [], updatedAt: 3 },
      approvals: [],
    });
    await poll();
    assert.ok(
      emitted.some(
        (event) =>
          event.type === "approval-resolved" &&
          event.id === `cowork-device:${hostId}:7`,
      ),
    );
    devices.clear();
    assert.equal(polling.size, 0);
    await devices.snapshot(snapshot);
    assert.equal(polling.size, 1);
    env.trust().revoke(pending.id);
    await poll();
    assert.equal(browser.isRevoked(hostId), true);
    assert.equal(polling.size, 0);
    const attempts = authenticated;
    await assert.rejects(browser.call(env.raw, hostId, "send", []), /revoked/);
    assert.equal(authenticated, attempts);
    account = undefined;
    await assert.rejects(browser.call(env.raw, hostId, "send", []), /Sign in/);
  } finally {
    devices.clear();
    if (oldCrypto) Object.defineProperty(globalThis, "crypto", oldCrypto);
    else Reflect.deleteProperty(globalThis, "crypto");
    env.link.disconnect();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("registered desktop dispatch IPC signs actual remote calls and stops transport after revocation or sign-out", async () => {
  const { registerDispatchHandlers } =
    await import("../../electron/ipc/dispatch");
  const directory = temporary();
  const env = await relay(directory);
  const previousFetch = globalThis.fetch;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let signedIn = true;
  let requests = 0;
  const signedInHost = {
    ready: true,
    accounts: { baseUrl: "https://service.example" },
    session: {
      userId: "account-a",
      authorized: async (callback: (token: string) => unknown) =>
        callback("desktop-account-token"),
    },
  };
  const ctx = {
    store: { root: directory },
    services: {},
    get remote() {
      return signedIn ? signedInHost : undefined;
    },
  };
  globalThis.fetch = (async (url, init) => {
    requests++;
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer desktop-account-token",
    );
    const method = String(url).split("/").at(-1) as DeviceMethod;
    try {
      return new Response(
        JSON.stringify({
          ok: true,
          value: await env.raw(method, JSON.parse(String(init?.body)).args),
        }),
      );
    } catch (error) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: { message: (error as Error).message },
        }),
      );
    }
  }) as typeof fetch;
  registerDispatchHandlers(
    ((name: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(name, handler);
    }) as never,
    ctx as never,
  );
  const call = (method: DeviceMethod, args: unknown[]) =>
    Promise.resolve(handlers.get("dispatchCall")!(hostId, method, args));
  try {
    env.trust().setRequired(true);
    await assert.rejects(
      call("send", [{ text: "pending" }]),
      /Approve this device/,
    );
    const pending = env.trust().state().pending[0];
    assert.equal(env.calls.length, 0);
    env.trust().approve(pending.id, pending.fingerprint);
    await call("openConversation", ["task"]);
    assert.equal(env.calls[0][0], "openConversation");
    env.trust().revoke(pending.id);
    await assert.rejects(call("openConversation", ["task"]), /revoked/);
    const afterRevoke = requests;
    await assert.rejects(call("openConversation", ["task"]), /revoked/);
    assert.equal(requests, afterRevoke);
    signedIn = false;
    await assert.rejects(call("send", []), /Sign in/);
    assert.equal(requests, afterRevoke);
  } finally {
    globalThis.fetch = previousFetch;
    env.link.disconnect();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("revoking a client while a host call is pending withholds the late result", async () => {
  const directory = temporary();
  const env = await relay(directory);
  const client = new DesktopDeviceTrustClient(
    () => directory,
    () => scope,
    () => "Desktop",
  );
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    env.trust().setRequired(true);
    await assert.rejects(
      client.call(env.raw, hostId, "send", []),
      /Approve this device/,
    );
    const pending = env.trust().state().pending[0];
    env.trust().approve(pending.id, pending.fingerprint);
    env.setDelay(() => delayed);
    const result = client.call(env.raw, hostId, "send", [
      { text: "already authorized" },
    ]);
    await tick();
    assert.equal(env.calls.length, 1);
    env.trust().revoke(pending.id);
    release();
    await assert.rejects(result, /Device access changed/);
  } finally {
    env.link.disconnect();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a renewed link id keeps the trust requirement and drops the trusted devices", () => {
  const directory = temporary();
  try {
    const first = new DeviceTrustStore(directory, scope, hostId);
    first.setRequired(true);
    const client = signer();
    first.enroll(
      client.envelope(
        first.challenge(client.identity),
        "deviceTrustEnroll",
        [],
      ),
    );
    const pending = first.state().pending[0];
    first.approve(pending.id, pending.fingerprint);
    assert.equal(first.state().trusted.length, 1);
    const renewed = new DeviceTrustStore(directory, scope, "pc-renewed-host");
    const state = renewed.state();
    assert.equal(state.requireTrustedDevices, true);
    assert.deepEqual(state.trusted, []);
    assert.equal(
      renewed.challenge(signer().identity).deviceId,
      "pc-renewed-host",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
