import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import type { AuthStatus } from "../../shared/types";
import { emailLinkRequest } from "../../shared/email-link";

test("web callbacks require the requesting tab proof, survive reload, and never replace another account", async (context) => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  let address = new URL("https://claudex.example/login");
  const location = {
    get href() {
      return address.href;
    },
    get origin() {
      return address.origin;
    },
    get pathname() {
      return address.pathname;
    },
    get search() {
      return address.search;
    },
  };
  const storage = new Map<string, string>();
  const channels: FakeChannel[] = [];
  class FakeChannel {
    onmessage?: (event: { data: unknown }) => void;
    messages: unknown[] = [];
    constructor(_name: string) {
      channels.push(this);
    }
    postMessage(message: unknown) {
      this.messages.push(message);
    }
    close() {}
  }
  const globals = {
    window,
    document,
    navigator: { platform: "iPhone", userAgent: "iPhone" },
    location,
    history: {
      replaceState: (_state: unknown, _title: string, path: string) => {
        address = new URL(path, address);
      },
    },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    BroadcastChannel: FakeChannel,
    __CLAUDEX_SURFACE__: "web",
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  const logins: unknown[][] = [];
  const account = {
    id: "7",
    email: "ada@example.com",
    name: "Ada",
    remote: true,
  };
  let signedIn = 0;
  let reloaded = 0;
  Object.assign(window, {
    desktop: {
      onEvent: () => () => {},
      sendSignInCode: async () => ({ countdown: 60 }),
      loginWithCode: async (...args: unknown[]) => {
        logins.push(args);
        return account;
      },
    },
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  // React listens for input events only where the document has them.
  (document as unknown as { oninput: null }).oninput = null;
  const { createRoot } = await import("react-dom/client");
  const { default: SignInPage } = await import("../../src/auth/SignInPage");
  const root = createRoot(document.querySelector("main")!);
  const status: AuthStatus = {
    hasAccounts: true,
    remote: { emailCodeLogin: true } as AuthStatus["remote"],
  };
  const render = (key: string, current = status) =>
    root.render(
      createElement(SignInPage, {
        key,
        status: current,
        onSignedIn: () => {
          signedIn++;
        },
        onRetry: () => {
          reloaded++;
        },
      }),
    );
  const link = (request: { request_id: string }) =>
    "https://claudex.example/sign-in/callback#" +
    new URLSearchParams({
      email: "ada@example.com",
      request_id: request.request_id,
      code: "123456",
    });
  try {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    await act(async () => render("sender"));
    // Enter the email: the prototype's setter goes round React's value
    // tracker, so the input event reads as a change.
    await act(async () => {
      const field = document.querySelector<HTMLInputElement>(
        'input[type="email"]',
      )!;
      Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(field),
        "value",
      )!.set!.call(field, "ada@example.com");
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await act(async () =>
      document
        .querySelector("form")!
        .dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    const request = JSON.parse(storage.get("claudex-email-link")!);
    assert.match(request.request_secret, /^[a-f0-9]{64}$/);
    const sender = channels.at(-1)!;
    await act(async () =>
      sender.onmessage!({ data: link({ request_id: "a".repeat(64) }) }),
    );
    assert.equal(logins.length, 0);
    await act(async () => sender.onmessage!({ data: link(request) }));
    assert.equal(signedIn, 1);
    assert.deepEqual(logins[0], [
      "ada@example.com",
      "123456",
      {
        request_id: request.request_id,
        request_secret: request.request_secret,
        desktop: false,
      },
    ]);
    assert.equal(storage.size, 0);
    assert.deepEqual(sender.messages, [{ completed: request.request_id }]);

    address = new URL(link(request));
    await act(async () => render("other-device"));
    assert.match(
      document.body.textContent!,
      /Enter this verification code where you first tried to sign in/,
    );
    assert.equal(logins.length, 1);
    assert.equal(address.hash, "");
    assert.deepEqual(channels.at(-1)!.messages, [link(request)]);
    await act(async () =>
      channels.at(-1)!.onmessage!({ data: { completed: request.request_id } }),
    );
    assert.equal(reloaded, 1);
    assert.equal(address.pathname, "/new");

    const pending = {
      ...emailLinkRequest(false),
      email: "Ada@Example.com",
      expiresAt: Date.now() + 600_000,
    };
    storage.set("claudex-email-link", JSON.stringify(pending));
    address = new URL(link(pending));
    await act(async () => render("same-tab-reload"));
    assert.equal(logins.length, 2);
    assert.deepEqual(logins[1], [
      "ada@example.com",
      "123456",
      {
        request_id: pending.request_id,
        request_secret: pending.request_secret,
        desktop: false,
      },
    ]);
    assert.equal(address.pathname, "/new");

    storage.set("claudex-email-link", JSON.stringify(pending));
    address = new URL(link(pending));
    await act(async () =>
      render("already-signed-in", {
        ...status,
        account: { ...account, id: "99", email: "other@example.com" },
      }),
    );
    assert.equal(logins.length, 2);
    assert.match(
      document.body.textContent!,
      /Use verification code to continue/,
    );
  } finally {
    await act(async () => root.unmount());
    context.mock.timers.reset();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
