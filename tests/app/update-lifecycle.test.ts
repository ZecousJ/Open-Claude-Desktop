import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ownershipAdmin,
  ownershipCheck,
  ownershipCopy,
  ownershipDeclineMs,
  ownershipFixScript,
  type OwnershipHost,
} from "../../electron/updates/ownership";
import {
  StealthUpdate,
  stealthIdleMs,
  stealthRetryMs,
  type StealthState,
} from "../../electron/updates/stealth";
import {
  saveStealthWindow,
  takeStealthWindow,
} from "../../electron/updates/stealth-window";
import { hostedUiUrl, warmHostedUi } from "../../electron/app/hosted-ui";
import {
  macApplyCommand,
  macApplyScript,
} from "../../electron/updates/scripts";

function ownership(overrides: Partial<OwnershipHost> = {}) {
  const events: string[] = [];
  let declined: number | undefined;
  const host: OwnershipHost = {
    rootWheel: async () => true,
    groups: () => [20, 80],
    declinedAt: () => declined,
    decline: (value) => {
      declined = value;
    },
    confirm: async () => {
      events.push("confirm");
      return true;
    },
    fix: async () => {
      events.push("fix");
    },
    failed: async () => {
      events.push("failed");
    },
    now: () => ownershipDeclineMs * 2,
    ...overrides,
  };
  return { check: ownershipCheck(host), events, host };
}

test("ownership checks skip non-root:wheel, non-admins, and recent declines", async () => {
  for (const override of [
    { rootWheel: async () => false },
    { groups: () => [20] },
    { declinedAt: () => ownershipDeclineMs * 2 - 1 },
  ]) {
    const { check, events } = ownership(override);
    await check();
    assert.deepEqual(events, []);
  }
  assert.equal(ownershipAdmin(undefined), true);
  assert.equal(
    ownershipAdmin(Array.from({ length: 16 }, (_, index) => index)),
    true,
  );
  assert.equal(ownershipAdmin([20]), false);
});

test("ownership prompts once and deduplicates concurrent update checks", async () => {
  const { check, events, host } = ownership();
  assert.deepEqual(await Promise.all([check(), check()]), [true, true]);
  assert.equal(await check(), true);
  assert.deepEqual(events, ["confirm", "fix"]);
  assert.equal(host.declinedAt(), undefined);
});

test("declines persist for seven days and can be retried at the boundary", async () => {
  const declined = ownership({ confirm: async () => false });
  assert.equal(await declined.check(), false);
  assert.equal(declined.host.declinedAt(), ownershipDeclineMs * 2);
  const retry = ownership({ declinedAt: () => ownershipDeclineMs });
  assert.equal(await retry.check(), true);
  assert.deepEqual(retry.events, ["confirm", "fix"]);
});

test("failed ownership repairs show the official error; canceled authorization does not", async () => {
  for (const [message, expected] of [
    ["repair failed", ["confirm", "failed"]],
    ["User canceled authorization", ["confirm"]],
  ] as const) {
    const flow = ownership({
      fix: async () => {
        throw new Error(message);
      },
    });
    assert.equal(await flow.check(), false);
    assert.deepEqual(flow.events, expected);
    assert.equal(flow.host.declinedAt(), ownershipDeclineMs * 2);
  }
  assert.equal(ownershipCopy.title, "Fix required for auto-updates");
  assert.ok(
    ownershipCopy.detail.includes("Claudex needs to fix the ownership"),
  );
});

test("permission repair quotes app paths rather than interpolating shell syntax", () => {
  const script = ownershipFixScript(
    "/Applications/Bob's $(touch /tmp/bad).app",
  );
  assert.ok(script.startsWith("do shell script "));
  assert.ok(script.endsWith(" with administrator privileges"));
  const command = JSON.parse(script.slice(16, -30));
  assert.ok(command.includes("'\\''"));
  assert.ok(command.includes("root:staff"));
});

const idle: StealthState = {
  enabled: true,
  ready: true,
  failed: false,
  busy: false,
  focused: false,
  fullScreen: false,
  checking: false,
};

test("stealth install requires ten uninterrupted minutes and runs only once", () => {
  let installs = 0;
  const flow = new StealthUpdate(() => {
    installs++;
  });
  flow.update(idle, 0);
  flow.update(idle, stealthIdleMs - 1);
  assert.equal(installs, 0);
  flow.update(idle, stealthIdleMs);
  flow.update(idle, stealthIdleMs * 2);
  assert.equal(installs, 1);
});

test("session, focus, fullscreen, gate, staging and failed-install blockers reset the countdown", () => {
  for (const blocked of [
    { busy: true },
    { focused: true },
    { fullScreen: true },
    { enabled: false },
    { ready: false },
    { failed: true },
  ]) {
    let installs = 0;
    const flow = new StealthUpdate(() => {
      installs++;
    });
    flow.update(idle, 0);
    flow.update({ ...idle, ...blocked }, stealthIdleMs - 1);
    flow.update(idle, stealthIdleMs);
    assert.equal(installs, 0);
    flow.update(idle, stealthIdleMs * 2);
    assert.equal(installs, 1);
  }
});

test("a staged recheck defers install without losing the idle countdown", () => {
  let installs = 0;
  const flow = new StealthUpdate(() => {
    installs++;
  });
  flow.update(idle, 0);
  flow.update({ ...idle, checking: true }, stealthIdleMs);
  assert.equal(installs, 0);
  flow.update(idle, stealthIdleMs + 1000);
  assert.equal(installs, 0);
  flow.update(idle, stealthIdleMs + stealthRetryMs);
  assert.equal(installs, 1);
});

test("stealth relaunch restores visible, hidden and minimized state only once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-stealth-"));
  try {
    for (const state of [
      { visible: true, minimized: false },
      { visible: false, minimized: false },
      { visible: true, minimized: true },
    ]) {
      saveStealthWindow(dir, state);
      assert.deepEqual(takeStealthWindow(dir), state);
      assert.equal(takeStealthWindow(dir), undefined);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(macApplyScript.includes('/usr/bin/open -g "$APP"'));
  const command = macApplyCommand("install.sh", {
    pid: 1,
    file: "update.zip",
    target: "Claudex.app",
    relaunch: true,
    background: true,
    resultFile: "result",
    version: "1.0.0",
    stagedRecord: "staged",
  });
  assert.equal(command.args.at(-1), "1");
});

test("hosted desktop UI accepts only explicitly configured HTTPS and preserves window queries", () => {
  assert.equal(hostedUiUrl("index.html", undefined, ""), undefined);
  for (const source of [
    "http://example.com/",
    "file:///tmp/index.html",
    "https://user:password@example.com/",
  ])
    assert.throws(() => hostedUiUrl("index.html", undefined, source));
  assert.equal(
    hostedUiUrl(
      "index.html",
      { window: "conversation", id: "123" },
      "https://example.com/desktop/index.html",
    ),
    "https://example.com/desktop/index.html?window=conversation&id=123",
  );
  assert.equal(
    hostedUiUrl(
      "quick.html",
      undefined,
      "https://example.com/desktop/index.html",
    ),
    "https://example.com/desktop/quick.html",
  );
});

test("hosted asset warm-up uses preconnect, ping.txt and a five-second abort signal", async () => {
  const connections: unknown[] = [];
  let fetched = "";
  let options: RequestInit | undefined;
  warmHostedUi(
    {
      preconnect: (value) => {
        connections.push(value);
      },
      resolveProxy: async () => "DIRECT",
      fetch: async (url, init) => {
        fetched = String(url);
        options = init;
        return new Response("ok");
      },
    },
    "https://app.example.com/desktop/index.html",
    "https://assets.example.com/v2/",
    () => {},
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(connections, [
    { url: "https://app.example.com", numSockets: 1 },
    { url: "https://assets.example.com", numSockets: 3 },
  ]);
  assert.equal(fetched, "https://assets.example.com/v2/ping.txt");
  assert.equal(options?.credentials, "omit");
  assert.equal(options?.cache, "no-store");
  assert.equal(options?.redirect, "error");
  assert.ok(options?.signal instanceof AbortSignal);
});
