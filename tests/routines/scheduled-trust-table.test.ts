import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import { routineDom } from "../support/routine-dom";
import { AccountDeviceSettings } from "../../src/settings/tabs/AccountTrustedDevices";
import { AppContext } from "../../src/app/AppContext";
import type { DeviceTrustState } from "../../shared/remote-devices";

const clients = (length: number) =>
  Array.from({ length }, (_, i) => ({
    id: `client-${i}`,
    name: `Browser ${i}`,
    platform: "macOS",
    fingerprint: `fingerprint-${i}`,
    addedAt: "2026-10-18T10:00:00Z",
  }));
async function fixture(length = 6) {
  let state: DeviceTrustState = {
    requireTrustedDevices: true,
    trusted: clients(length),
    pending: [],
  };
  let pending: Promise<DeviceTrustState> | undefined;
  const revoked: string[] = [],
    errors: unknown[] = [];
  const env = await routineDom(
    {
      deviceTrustState: async () => structuredClone(state),
      setRequireTrustedDevices: async () => structuredClone(state),
      approveDeviceTrust: async () => structuredClone(state),
      rejectDeviceTrust: async () => structuredClone(state),
      revokeDeviceTrust: async (id) => {
        revoked.push(id);
        if (pending) return pending;
        state = {
          ...state,
          trusted: state.trusted.filter((client) => client.id !== id),
        };
        return structuredClone(state);
      },
      listCoworkDevices: async () => [],
    },
    { jsdom: true },
  );
  const dimensions = new Map(
    ["innerWidth", "innerHeight"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.defineProperty(globalThis, "innerWidth", {
    configurable: true,
    value: 1280,
  });
  Object.defineProperty(globalThis, "innerHeight", {
    configurable: true,
    value: 720,
  });
  const clean = async () => {
    await env.clean();
    for (const [key, value] of dimensions) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  const ref = { current: undefined as unknown };
  const actor = (id: string) => ({
    accountId: id,
    controllerScope: {},
    currentController: ref,
  });
  const first = actor("a");
  ref.current = first;
  const render = (controller = first, paged = true) => {
    ref.current = controller;
    return env.render(
      h(
        AppContext.Provider,
        { value: controller as never },
        h(
          "section",
          { className: "settings-account" },
          h(AccountDeviceSettings, {
            paged,
            onError: (error) => errors.push(error),
          }),
        ),
      ),
    );
  };
  const button = (label: string, parent: ParentNode = env.document) =>
    [...parent.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) =>
        item.textContent?.trim() === label ||
        item.getAttribute("aria-label") === label,
    )!;
  const dialog = () =>
    env.document.querySelector<HTMLElement>(
      '[role="alertdialog"],[role="dialog"]',
    );
  await render();
  return {
    ...env,
    clean,
    render,
    actor,
    first,
    revoked,
    errors,
    button,
    dialog,
    setPending: (value: Promise<DeviceTrustState> | undefined) =>
      (pending = value),
    setState: (value: DeviceTrustState) => (state = value),
  };
}

test("actual trusted-device table conditionally pages five rows and clamps after acknowledged removal", async () => {
  const env = await fixture();
  try {
    assert.equal(
      env.document.querySelectorAll(".account-trusted-devices tbody tr").length,
      5,
    );
    // Require trusted devices belongs to the Account group above it: no gap.
    assert.ok(
      [...env.document.querySelectorAll(".settings-section")]
        .find((section) =>
          section.textContent?.includes("Require trusted devices"),
        )
        ?.classList.contains("joins-above"),
    );
    assert.deepEqual(
      [...env.document.querySelectorAll(".account-trusted-devices th")].map(
        (item) => item.textContent,
      ),
      ["Device", "Added", ""],
    );
    await env.event(env.button("Next page"), "click");
    assert.equal(
      env.document.querySelectorAll(".account-trusted-devices tbody tr").length,
      1,
    );
    await env.event(env.button("Actions for Browser 5 on macOS"), "click");
    await env.event(env.button("Remove"), "click");
    assert.equal(env.revoked.length, 0);
    assert.match(env.dialog()?.textContent ?? "", /Remove trusted device\?/);
    assert.equal(env.document.activeElement?.textContent, "Cancel");
    await env.event(env.button("Remove", env.dialog()!), "click");
    assert.deepEqual(env.revoked, ["client-5"]);
    assert.equal(env.dialog(), null);
    assert.equal(
      env.document.querySelectorAll(".account-trusted-devices tbody tr").length,
      5,
    );
    assert.ok(!env.button("Next page"));
    assert.deepEqual(env.errors, []);
  } finally {
    await env.clean();
  }
});

test("confirmation Cancel never revokes, and the unpaged branch retains the full real inventory", async () => {
  const env = await fixture();
  try {
    await env.render(env.first, false);
    assert.equal(
      env.document.querySelectorAll(".account-trusted-devices tbody tr").length,
      6,
    );
    assert.ok(!env.button("Next page"));
    await env.event(env.button("Actions for Browser 0 on macOS"), "click");
    await env.event(env.button("Remove"), "click");
    await env.event(env.button("Cancel", env.dialog()!), "click");
    assert.equal(env.dialog(), null);
    assert.deepEqual(env.revoked, []);
  } finally {
    await env.clean();
  }
});

test("a late prior-account removal cannot mutate or keep the replacement account's controls busy", async () => {
  const env = await fixture(1);
  let finish!: (value: DeviceTrustState) => void;
  env.setPending(new Promise((resolve) => (finish = resolve)));
  try {
    await env.event(env.button("Actions for Browser 0 on macOS"), "click");
    await env.event(env.button("Remove"), "click");
    await env.event(env.button("Remove", env.dialog()!), "click");
    const second = env.actor("b");
    env.setState({
      requireTrustedDevices: true,
      trusted: [{ ...clients(1)[0], name: "Replacement" }],
      pending: [],
    });
    await env.render(second);
    assert.equal(
      env.button("Actions for Replacement on macOS").disabled,
      false,
    );
    await act(async () =>
      finish({ requireTrustedDevices: true, trusted: [], pending: [] }),
    );
    assert.match(
      env.document.querySelector(".account-trusted-devices")!.textContent ?? "",
      /Replacement/,
    );
    assert.deepEqual(env.revoked, ["client-0"]);
    assert.deepEqual(env.errors, []);
  } finally {
    await env.clean();
  }
});
