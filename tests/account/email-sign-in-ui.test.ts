import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { AppEvent, AuthStatus } from "../../shared/types";
import type { EmailLinkRequest } from "../../shared/email-link";

test("the mailbox accent applies to its 32px font icon", async () => {
  const { Mailbox } = await import("../../src/ui/glyphs");
  const markup = renderToStaticMarkup(
    createElement(Mailbox, { size: 32, className: "signin-mailbox-icon" }),
  );
  assert.match(markup, /<svg[^>]*width="32"[^>]*data-icon="Mailbox"/);
  assert.match(markup, /signin-mailbox-icon/);
  const css = readFileSync(
    new URL("../../src/auth/sign-in.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.signin-mailbox-icon \{\s+color: #6da7ec;/);
  assert.doesNotMatch(css, /\.signin-mailbox > svg/);
});

test("the sign-in card is filled with surface-1 and the form has the shell's 16px gap", () => {
  const css = readFileSync(
    new URL("../../src/auth/sign-in.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /--auth-card-surface: #151515;/);
  assert.match(css, /--auth-card-surface: #fcfcfb;/);
  assert.match(
    css,
    /\.signin-card \{[^}]*background: var\(--auth-card-surface\);/,
  );
  assert.match(
    css,
    /:root\[data-surface="web"\] \.signin-card form \{\s*gap: 16px;/,
  );
  assert.doesNotMatch(css, /\.signin-card form > \.signin-primary \{/);
});

test("cross-device code box preserves the official default border in both themes", () => {
  const css = readFileSync(
    new URL("../../src/auth/sign-in.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.signin-link-code \{\s*border: 1px solid hsl\(51 16\.5% 84\.5%\)/,
  );
  assert.match(
    css,
    /:root\[data-theme="light"\] \.signin-link-code \{\s*border-color: hsl\(30 3\.3% 11\.8%\)/,
  );
  assert.match(
    css,
    /:root:not\(\[data-theme\]\) \.signin-link-code \{\s*border-color: hsl\(30 3\.3% 11\.8%\)/,
  );
});

test("mailbox, timed code entry, requesting-window callback and cross-device fallback", async (context) => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const globals = {
    window,
    document,
    navigator: { platform: "MacIntel", userAgent: "Macintosh" },
    location: {
      href: "file:///index.html",
      pathname: "/index.html",
      search: "",
    },
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
  const listeners = new Set<(event: AppEvent) => void>();
  let request: EmailLinkRequest | undefined;
  const logins: unknown[][] = [];
  const account = {
    id: "7",
    email: "ada@example.com",
    name: "Ada",
    remote: true,
  };
  let signedIn = false;
  Object.assign(window, {
    desktop: {
      onEvent: (listener: (event: AppEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      sendSignInCode: async (_email: string, pending: EmailLinkRequest) => {
        request = pending;
        return { countdown: 60 };
      },
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
  const render = (key: string) =>
    root.render(
      createElement(SignInPage, {
        key,
        status,
        onSignedIn: () => {
          signedIn = true;
        },
        onRetry() {},
      }),
    );
  const click = async (label: string) => {
    const button = [...document.querySelectorAll("button")].find(
      (item) => item.textContent === label,
    );
    assert.ok(button, label);
    await act(async () =>
      button.dispatchEvent(new window.Event("click", { bubbles: true })),
    );
  };
  try {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    await act(async () => render("first"));
    await click("Get started");
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
    assert.ok(request);
    assert.match(
      document.body.textContent!,
      /To continue, click the link sent to/,
    );
    assert.match(document.body.textContent!, /Enter verification code/);
    assert.match(document.body.textContent!, /Resend email/);
    assert.match(document.body.textContent!, /Use a different email/);
    assert.equal(document.querySelector("input"), null);
    await act(async () => context.mock.timers.tick(5000));
    assert.ok(
      document.querySelector(".signin-code-input"),
      document.body.innerHTML,
    );
    assert.match(document.body.textContent!, /use your password/);
    await act(async () => {
      for (const listener of listeners)
        listener({
          type: "email-sign-in-link",
          link: {
            email: "ada@example.com",
            request_id: request!.request_id,
            code: "123456",
          },
        });
    });
    assert.equal(signedIn, true);
    assert.deepEqual(logins[0], ["ada@example.com", "123456", request]);
    await act(async () => render("other-device"));
    await act(async () => {
      for (const listener of listeners)
        listener({
          type: "email-sign-in-link",
          link: {
            email: "ada@example.com",
            request_id: "a".repeat(64),
            code: "654321",
          },
        });
    });
    assert.match(
      document.body.textContent!,
      /Use verification code to continue/,
    );
    assert.match(
      document.body.textContent!,
      /Enter this verification code where you first tried to sign in/,
    );
    assert.match(document.body.textContent!, /654321/);
    assert.match(document.body.textContent!, /Copy code/);
    assert.equal(logins.length, 1);
  } finally {
    await act(async () => root.unmount());
    context.mock.timers.reset();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
