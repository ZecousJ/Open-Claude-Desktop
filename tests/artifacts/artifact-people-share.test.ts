import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import type {
  ArtifactSharingState,
  ShareAccess,
} from "../../shared/sharing-api";

test("artifact access sheet invites, removes, copies the authenticated link and changes general access", async () => {
  const { window, document } = parseHTML(
    '<html data-motion="reduced"><body><main></main></body></html>',
  );
  (document as unknown as { oninput: null }).oninput = null;
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
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 350,
    bottom: 40,
    width: 350,
    height: 40,
    toJSON() {},
  });
  let state: ArtifactSharingState = {
    share: {
      id: "one",
      kind: "artifact",
      sourceKey: "card",
      title: "Card",
      url: "https://example.test/s/card",
      inviteUrl: "https://example.test/shared/card",
      status: "active",
      createdAt: 1,
      snapshotAt: 1,
      access: "invited",
      invites: ["first@example.com"],
    },
    currentVersion: "one",
    versions: [],
    autoUpdate: false,
  };
  const copied: string[] = [];
  const invitations: string[] = [];
  const inviteOptions: unknown[] = [];
  const errors: unknown[] = [];
  Object.assign(window, {
    desktop: {
      artifactShareState: async () => structuredClone(state),
      inviteToArtifact: async (
        _id: string,
        email: string,
        options: unknown,
      ) => {
        invitations.push(email);
        inviteOptions.push(options);
        state = {
          ...state,
          share: {
            ...state.share!,
            invites: [...state.share!.invites!, email],
          },
        };
        return { share: state.share, added: true, mailed: true };
      },
      removeArtifactInvite: async (_id: string, email: string) => {
        state = {
          ...state,
          share: {
            ...state.share!,
            invites: state.share!.invites!.filter((value) => value !== email),
          },
        };
        return state.share;
      },
      setArtifactShareAccess: async (_input: unknown, access: ShareAccess) => {
        state = { ...state, share: { ...state.share!, access } };
        return state;
      },
      copyText: async (value: string) => {
        copied.push(value);
      },
    },
  });
  const { createRoot } = await import("react-dom/client");
  const { ArtifactShareDialog } =
    await import("../../src/artifacts/ArtifactShareDialog");
  const root = createRoot(document.querySelector("main")!);
  const click = async (selector: string) => {
    const button = document.querySelector<HTMLButtonElement>(selector);
    assert.ok(button, selector);
    await act(async () => button.click());
  };
  try {
    await act(async () =>
      root.render(
        createElement(ArtifactShareDialog, {
          input: {
            identity: "card",
            title: "Card",
            language: "html",
            content: "<p>Card</p>",
          },
          access: true,
          onClose() {},
          onChanged() {},
          onError: (error) => errors.push(error),
        }),
      ),
    );
    assert.match(document.body.textContent!, /People with access/);
    assert.match(document.body.textContent!, /General access/);
    // Invited is the starting audience; its line is the original's.
    assert.match(
      document.body.textContent!,
      /Only people with access can open the link\./,
    );
    assert.doesNotMatch(
      document.body.textContent!,
      /Automatically share updates|Publish & copy link/,
    );
    const input = document.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(input),
        "value",
      )!.set!.call(input, "new@example.com");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    const role = document.querySelector("select") as HTMLSelectElement;
    Object.defineProperty(role, "value", {
      configurable: true,
      value: "comment",
    });
    role.dispatchEvent(new window.Event("change", { bubbles: true }));
    const message = document.querySelector("textarea") as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(message),
      "value",
    )!.set!.call(message, "Please review this artifact.");
    message.dispatchEvent(new window.Event("input", { bubbles: true }));
    await act(async () =>
      document
        .querySelector("form")!
        .dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    assert.deepEqual(invitations, ["new@example.com"]);
    assert.deepEqual(inviteOptions, [
      {
        role: "comment",
        notify: true,
        message: "Please review this artifact.",
      },
    ]);
    assert.match(document.body.textContent!, /new@example.com/);
    await click('button[aria-label="Remove new@example.com"]');
    assert.doesNotMatch(document.body.textContent!, /new@example.com/);
    await click(".artifact-share-footer button");
    assert.deepEqual(copied, ["https://example.test/shared/card"]);
    await click('[data-testid="share-sheet-audience"]');
    const anyone = [
      ...document.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]'),
    ].find((button) => button.textContent === "Anyone with the link");
    assert.ok(anyone);
    await act(async () => anyone.click());
    assert.equal(state.share?.access, "link");
    assert.deepEqual(errors, []);
    assert.match(
      document.body.textContent!,
      /People with the link can view, but not edit\./,
    );
  } finally {
    await act(async () => root.unmount());
    for (const [key, value] of saved)
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
  }
});
