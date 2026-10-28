import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { SshToolGrantsDialog } from "../../src/ssh/SshToolGrantsDialog";
import { AddSshHostDialog } from "../../src/ssh/AddSshHostDialog";
import type { SshToolGrant } from "../../shared/ssh-api";

test("SSH tool management renders real grants, removes them and shows the official empty state", async () => {
  const { window, document } = parseHTML(
    '<html data-motion="reduced"><body><main></main></body></html>',
  );
  const globals = {
    window,
    document,
    innerHeight: 1000,
    innerWidth: 1000,
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: () => ({ getPropertyValue: () => "0" }),
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout,
    CSS: { escape: (value: string) => value },
  };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.assign(globalThis, globals);
  const errors: unknown[] = [];
  let grants: SshToolGrant[] = [
    {
      endpointKey: "host",
      server: "linear",
      toolName: "create_issue",
      hostLabel: "Devbox",
      serverLabel: "Linear",
      toolLabel: "Create issue",
      serverKey: "server",
      hostKey: "key",
      grantedAt: 1,
    },
  ];
  const removed: string[][] = [];
  Object.assign(window, {
    desktop: {
      sshToolGrants: async () => grants,
      sshRemoveToolGrant: async (...args: string[]) => {
        removed.push(args);
        grants = [];
      },
      sshClearToolGrants: async () => {
        grants = [];
      },
    },
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  try {
    await act(async () =>
      root.render(
        createElement(
          AppContext.Provider,
          {
            value: {
              report: (error: unknown) => {
                errors.push(error);
              },
            } as unknown as AppController,
          },
          createElement(SshToolGrantsDialog, { onClose() {} }),
        ),
      ),
    );
    assert.match(document.body.textContent!, /Create issue \(Linear\)/);
    assert.match(document.body.textContent!, /Devbox/);
    const remove = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove Create issue (Linear) on Devbox"]',
    );
    assert.ok(remove);
    await act(async () => remove.click());
    assert.deepEqual(removed, [["host", "linear", "create_issue"]]);
    assert.match(
      document.body.textContent!,
      /Nothing here yet\. When you choose “Always allow”/,
    );
    const clear = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Clear all",
    );
    assert.ok(clear?.disabled);
    assert.deepEqual(errors, []);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});

test("editing a host exposes Delete connection and asks before deleting", async () => {
  const { window, document } = parseHTML(
    '<html data-motion="reduced"><body><main></main></body></html>',
  );
  const globals = {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: () => ({ getPropertyValue: () => "0" }),
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout,
  };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.assign(globalThis, globals);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  let deleted = 0;
  try {
    await act(async () =>
      root.render(
        createElement(AddSshHostDialog, {
          host: {
            id: "host",
            label: "Devbox",
            destination: "me@devbox",
            createdAt: 1,
          },
          suggestions: [],
          onTest: async () => ({ ok: true }),
          onSave: async () => {},
          onClose() {},
          onDelete: async () => {
            deleted++;
          },
        }),
      ),
    );
    const button = (text: string) =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (entry) => entry.textContent === text,
      )!;
    await act(async () => button("Delete connection").click());
    assert.equal(deleted, 0);
    assert.match(document.body.textContent!, /Delete SSH connection\?/);
    assert.match(
      document.body.textContent!,
      /“Devbox” will be permanently deleted\. This can’t be undone\./,
    );
    await act(async () => button("Cancel").click());
    assert.equal(deleted, 0);
    await act(async () => button("Delete connection").click());
    await act(async () => button("Delete").click());
    assert.equal(deleted, 1);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
