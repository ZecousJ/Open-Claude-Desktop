import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { AccountDevicesSection } from "../../src/settings/tabs/AccountDevices";
import { routineDom } from "../support/routine-dom";

test("mounted Account local devices use actual metadata, measured rows and working actions", async () => {
  const errors: unknown[] = [];
  const env = await routineDom(
    {
      listCoworkDevices: async () => [
        {
          id: "host",
          name: "Studio",
          platform: "darwin",
          version: "0.1",
          connectedAt: "2026-10-19T00:00:00Z",
          addedAt: "2026-10-16T00:00:00Z",
          lastSeenAt: "2026-10-18T00:00:00Z",
        },
        {
          id: "old",
          name: "Legacy host",
          platform: "win32",
          version: "0.1",
          connectedAt: "2026-10-19T00:00:00Z",
        },
      ],
    },
    { jsdom: true },
  );
  const globals = {
    innerWidth: 1280,
    innerHeight: 720,
    addEventListener: env.window.addEventListener.bind(env.window),
    removeEventListener: env.window.removeEventListener.bind(env.window),
  };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const style = env.document.createElement("style");
  style.textContent = readFileSync(
    new URL("../../src/settings/tabs/account-devices.css", import.meta.url),
    "utf8",
  );
  env.document.head.append(style);
  try {
    await env.render(
      h(
        "div",
        { className: "settings-account" },
        h(AccountDevicesSection, { onError: (error) => errors.push(error) }),
      ),
    );
    assert.deepEqual(
      [...env.document.querySelectorAll("th")].map((cell) => cell.textContent),
      ["Name", "OS", "Added", "Last seen", ""],
    );
    const rows = [...env.document.querySelectorAll("tbody tr")];
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent ?? "", /Studio.*macOS.*Oct 16, 2026/);
    assert.deepEqual(
      [...rows[1].querySelectorAll("td")]
        .slice(2, 4)
        .map((cell) => cell.textContent),
      ["—", "—"],
    );
    const more = env.document.querySelector<HTMLButtonElement>(
      'button[aria-label="Actions for Studio"]',
    )!;
    assert.equal(env.window.getComputedStyle(more).width, "32px");
    assert.equal(env.window.getComputedStyle(more).height, "32px");
    assert.equal(env.window.getComputedStyle(more).borderRadius, "8px");
    assert.equal(
      env.window.getComputedStyle(rows[0].querySelector("td")!).height,
      "49px",
    );
    await env.click('button[aria-label="Actions for Studio"]');
    const details = [
      ...env.document.querySelectorAll('[role="menuitem"]'),
    ].find((item) => item.textContent?.includes("Device details"))!;
    await env.event(details, "click");
    assert.match(
      env.document.querySelector('[role="status"]')?.textContent ?? "",
      /Studio · macOS · 0.1/,
    );
    assert.deepEqual(errors, []);
  } finally {
    await env.clean();
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("mounted Account policy, pending approval and trusted-client revocation use the actual scoped store", async () => {
  const { DeviceTrustStore } =
    await import("../../electron/remote-control/device-trust-store");
  const { generateKeyPairSync, sign } = await import("node:crypto");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { deviceTrustMessage } = await import("../../shared/remote-devices");
  const { AccountTab } = await import("../../src/settings/tabs/Account");
  const { defaultSettings } = await import("../../electron/store/store");
  const { act } = await import("react");
  const directory = mkdtempSync(join(tmpdir(), "claudex-b31-ui-trust-"));
  const store = new DeviceTrustStore(directory, "service:account-a", "pc-host");
  const keys = generateKeyPairSync("ed25519");
  const identity = {
    publicKey: keys.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    name: "Safari",
    platform: "macOS",
  };
  const challenge = store.challenge(identity);
  store.enroll({
    deviceTrust: {
      challengeId: challenge.id,
      signature: sign(
        null,
        Buffer.from(deviceTrustMessage(challenge, "deviceTrustEnroll", [])),
        keys.privateKey,
      ).toString("base64"),
    },
    args: [],
  });
  const errors: unknown[] = [];
  const env = await routineDom(
    {
      accountProfile: async () => ({
        kind: "remote",
        fullName: "Account Person",
        email: "person@example.test",
        canDelete: true,
      }),
      listCoworkDevices: async () => [],
      activeSessions: async () => null,
      deviceTrustState: async () => store.state(),
      setRequireTrustedDevices: async (required: boolean) =>
        store.setRequired(required),
      approveDeviceTrust: async (id: string, fingerprint: string) =>
        store.approve(id, fingerprint),
      rejectDeviceTrust: async (id: string) => store.reject(id),
      revokeDeviceTrust: async (id: string) => store.revoke(id),
    } as never,
    { jsdom: true },
  );
  const globals = {
    innerWidth: 1280,
    innerHeight: 720,
    addEventListener: env.window.addEventListener.bind(env.window),
    removeEventListener: env.window.removeEventListener.bind(env.window),
  };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const style = env.document.createElement("style");
  style.textContent =
    readFileSync(
      new URL("../../src/settings/settings.css", import.meta.url),
      "utf8",
    ) +
    readFileSync(
      new URL("../../src/settings/tabs/account-devices.css", import.meta.url),
      "utf8",
    );
  env.document.head.append(style);
  try {
    await env.render(
      h(AccountTab, {
        settings: defaultSettings,
        save: async () => true,
        platform: "darwin",
        engine: { state: "ready" },
        onError: (error: unknown) => errors.push(error),
        goTo() {},
      } as never),
    );
    // Resolve the actual Account lazy boundary before checking placement.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const toggle = env.document.querySelector<HTMLButtonElement>(
      '[role="switch"][aria-label="Require trusted devices"]',
    )!;
    assert.ok(toggle);
    assert.equal(toggle.disabled, false);
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    assert.equal(env.window.getComputedStyle(toggle).width, "36px");
    assert.equal(env.window.getComputedStyle(toggle).height, "20px");
    const page = env.document.querySelector(".settings-account")!;
    assert.ok(
      page.textContent!.indexOf("Require trusted devices") <
        page.textContent!.indexOf("Local devices"),
    );
    assert.ok(
      page.textContent!.indexOf("Local devices") <
        page.textContent!.indexOf("Trusted devices"),
    );
    assert.match(
      page.textContent!,
      /Verify each new device before it can connect to Claudex on your computer remotely/,
    );
    assert.equal(store.state().trusted.length, 0);
    const fingerprint = store.state().pending[0].fingerprint;
    assert.ok(page.textContent!.includes(fingerprint));
    await env.event(toggle, "click");
    assert.equal(store.state().requireTrustedDevices, true);
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    const approve = [...page.querySelectorAll("button")].find(
      (button) => button.textContent === "Approve device",
    )!;
    await env.event(approve, "click");
    assert.equal(store.state().trusted.length, 1);
    assert.equal(store.state().pending.length, 0);
    await env.click('button[aria-label="Actions for Safari on macOS"]');
    const revoke = [...env.document.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === "Remove",
    )!;
    await env.event(revoke, "click");
    assert.equal(store.state().trusted.length, 1);
    const confirmation = env.document.querySelector(
      '[role="alertdialog"],[role="dialog"]',
    )!;
    const remove = [...confirmation.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Remove",
    )!;
    await env.event(remove, "click");
    assert.equal(store.state().trusted.length, 0);
    // With none left, the heading and its note stand alone.
    assert.equal(page.querySelector(".account-trusted-devices"), null);
    assert.deepEqual(errors, []);
  } finally {
    await env.clean();
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("device trust read cannot expose the previous account's pending client after a controller switch", async () => {
  const { AppContext } = await import("../../src/app/AppContext");
  const { AccountDeviceSettings } =
    await import("../../src/settings/tabs/AccountTrustedDevices");
  const { act } = await import("react");
  let resolve!: (value: unknown) => void;
  let reads = 0;
  const old = new Promise((done) => {
    resolve = done;
  });
  const env = await routineDom({
    listCoworkDevices: async () => [],
    setRequireTrustedDevices: async () => ({
      requireTrustedDevices: false,
      trusted: [],
      pending: [],
    }),
    approveDeviceTrust: async () => ({
      requireTrustedDevices: false,
      trusted: [],
      pending: [],
    }),
    rejectDeviceTrust: async () => ({
      requireTrustedDevices: false,
      trusted: [],
      pending: [],
    }),
    revokeDeviceTrust: async () => ({
      requireTrustedDevices: false,
      trusted: [],
      pending: [],
    }),
    deviceTrustState: () =>
      ++reads === 1
        ? old
        : Promise.resolve({
            requireTrustedDevices: false,
            trusted: [],
            pending: [],
          }),
  } as never);
  const first = {
    accountId: "a",
    controllerScope: {},
    currentController: { current: undefined as unknown },
  };
  first.currentController.current = first;
  const second = {
    accountId: "b",
    controllerScope: {},
    currentController: first.currentController,
  };
  const errors: unknown[] = [];
  const render = (controller: unknown) =>
    env.render(
      h(
        AppContext.Provider,
        { value: controller as never },
        h(
          "div",
          { className: "settings-account" },
          h(AccountDeviceSettings, { onError: (error) => errors.push(error) }),
        ),
      ),
    );
  try {
    await render(first);
    first.currentController.current = second;
    await act(async () => {
      resolve({
        requireTrustedDevices: true,
        trusted: [],
        pending: [
          {
            id: "private",
            name: "Old private client",
            platform: "macOS",
            fingerprint: "private-fingerprint",
            addedAt: "2026-10-19T00:00:00Z",
          },
        ],
      });
    });
    assert.equal(
      env.document.body.textContent?.includes("Old private client"),
      false,
    );
    await render(second);
    assert.equal(
      env.document.body.textContent?.includes("Old private client"),
      false,
    );
    assert.equal(
      env.document
        .querySelector('[role="switch"]')
        ?.getAttribute("aria-checked"),
      "false",
    );
    assert.deepEqual(errors, []);
  } finally {
    await env.clean();
  }
});
