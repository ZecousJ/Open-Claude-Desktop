/**
 * Load failures: the boot error page tells a service that is down from one that
 * cannot be reached or a browser that is offline, and a page that cannot render
 * shows the danger banner with Try again (Reload once a retry failed or a
 * script did not load).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { act, Component, createElement, type ReactNode } from "react";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { bootFailureKind, isChunkLoadError } from "../../src/app/load-failure";

const { BootErrorPage } = await import("../../src/boot/BootErrorPage");
const { PageBoundary, PageErrorBanner } =
  await import("../../src/app/PageBoundary");
const { ChatLoadError } = await import("../../src/app/ChatLoadError");

const withStatus = (status: number) =>
  Object.assign(new Error("The server answered."), { status });
const withCode = (code: string) =>
  Object.assign(new Error("Refused."), { code });

test("a 5xx or the service's own refusal is the service being down", () => {
  for (const error of [
    withStatus(502),
    withStatus(503),
    withCode("CLAUDEX_WEB_CAPACITY"),
    withCode("CLAUDEX_WEB_DISABLED"),
  ])
    assert.equal(bootFailureKind(error, { online: true }), "unavailable");
  // Down wins over offline, as the original checks it first.
  assert.equal(
    bootFailureKind(withStatus(500), { online: false }),
    "unavailable",
  );
  // The desktop's main process answered the call itself.
  assert.equal(
    bootFailureKind(new Error("engine"), { online: true, answered: true }),
    "unavailable",
  );
  // ...unless the machine has no network: that is offline, not an outage.
  assert.equal(
    bootFailureKind(new Error("fetch failed"), {
      online: false,
      answered: true,
    }),
    "offline",
  );
});

test("anything else is offline when the browser says so, else unreachable", () => {
  const network = withCode("CLAUDEX_WEB_RUNNER_UNAVAILABLE");
  assert.equal(bootFailureKind(network, { online: false }), "offline");
  assert.equal(bootFailureKind(network, { online: true }), "unreachable");
  assert.equal(
    bootFailureKind(withStatus(404), { online: true }),
    "unreachable",
  );
  assert.equal(bootFailureKind(undefined, { online: true }), "unreachable");
});

test("a script that did not load is told from other errors", () => {
  for (const message of [
    "Failed to fetch dynamically imported module: https://x/assets/a.js",
    "error loading dynamically imported module",
    "Importing a module script failed.",
    "Unable to preload CSS for /assets/b.css",
  ])
    assert.ok(isChunkLoadError(new Error(message)), message);
  assert.equal(isChunkLoadError(new TypeError("x is undefined")), false);
  assert.equal(isChunkLoadError(undefined), false);
});

test("the boot error page says why, with the original's actions", () => {
  const down = renderToStaticMarkup(
    createElement(BootErrorPage, {
      error: withStatus(503),
      onLogOut: () => {},
    }),
  );
  assert.match(down, /Claudex is temporarily unavailable/);
  assert.match(down, /We’re working on it — try again in a moment\./);
  assert.match(down, /disabled="">Try again in 10s</);
  assert.match(down, />Log out</);

  const lost = renderToStaticMarkup(
    createElement(BootErrorPage, {
      error: withCode("CLAUDEX_WEB_RUNNER_UNAVAILABLE"),
      onLogOut: () => {},
    }),
  );
  // Node has no navigator.onLine: the browser counts as online.
  assert.match(lost, /Can’t reach Claudex/);
  assert.match(lost, /Check your connection\./);
  assert.match(lost, />Try again</);
  assert.doesNotMatch(lost, /Log out/);
});

class Throws extends Component<{ error: Error }> {
  render(): ReactNode {
    throw this.props.error;
  }
}

test("the page banner names the page; a session names the session", () => {
  const banner = renderToStaticMarkup(
    createElement(PageErrorBanner, {
      message: "Something went wrong loading this page.",
      action: "Try again",
      onAction: () => {},
    }),
  );
  assert.match(banner, /role="alert"/);
  assert.match(banner, /Something went wrong loading this page\./);
  assert.match(banner, />Try again</);
  // Rendering on the server does not run error boundaries; the fallback is
  // read from the state a caught error leaves.
  const state = PageBoundary.getDerivedStateFromError(
    new Error("Failed to fetch dynamically imported module: /a.js"),
  );
  assert.deepEqual(state, { failed: true, chunk: true });
  assert.deepEqual(PageBoundary.getDerivedStateFromError(new Error("boom")), {
    failed: true,
    chunk: false,
  });
  const boundary = new PageBoundary({
    resetKey: "chat",
    session: true,
    children: createElement(Throws, { error: new Error("boom") }),
  });
  boundary.state = { failed: true, retried: false, chunk: false };
  const session = renderToStaticMarkup(
    createElement(ChatLoadError, { session: true, onRetry: () => {} }),
  );
  assert.match(session, /Couldn’t load this session/);
  assert.match(session, /data-error-view|chat-load-error/);
  assert.match(session, />Try again</);
  const chat = new PageBoundary({
    resetKey: "chat",
    chat: true,
    children: null,
  });
  chat.state = { failed: true, retried: false, chunk: false };
  assert.match(
    renderToStaticMarkup(createElement(ChatLoadError, { onRetry: () => {} })),
    /Couldn’t load this chat/,
  );
  const page = new PageBoundary({ resetKey: "projects", children: null });
  page.state = { failed: true, retried: true, chunk: false };
  assert.match(renderToStaticMarkup(page.render() as never), />Reload</);
});

test("conversation errors retry online, announce loading and recover after failures", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window,
    document,
    navigator: { onLine: false, userAgent: "test" },
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  let attempts = 0;
  let reject: (error: Error) => void = () => {};
  const onRetry = () => {
    attempts++;
    return new Promise<void>((_resolve, rejectRequest) => {
      reject = rejectRequest;
    });
  };
  try {
    await act(() => root.render(createElement(ChatLoadError, { onRetry })));
    assert.match(document.body.textContent!, /You’re offline/);
    assert.equal(
      document.querySelector("svg.pictogram")?.getAttribute("width"),
      "96",
    );
    await act(() => {
      window.dispatchEvent(new window.Event("online"));
    });
    assert.equal(attempts, 1);
    assert.doesNotMatch(document.body.textContent!, /You’re offline/);
    assert.equal(
      document.querySelector("button")?.getAttribute("aria-label"),
      "Loading",
    );
    assert.ok(document.querySelector("button[disabled]"));
    await act(() => {
      window.dispatchEvent(new window.Event("online"));
    });
    assert.equal(attempts, 1);
    await act(async () => {
      reject(new Error("offline"));
    });
    assert.equal(document.querySelector("button[disabled]"), null);
    assert.equal(document.querySelector("button")?.textContent, "Try again");
    await act(() => {
      document.querySelector("button")!.click();
    });
    assert.equal(attempts, 2);
    await act(async () => {
      reject(new Error("failed again"));
    });
    assert.equal(document.querySelector("button[disabled]"), null);
    await act(() => {
      window.dispatchEvent(new window.Event("offline"));
    });
    assert.match(document.body.textContent!, /You’re offline/);
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("a failed Code turn names what failed and what to do", async () => {
  const { codeFailure, CodeTurnError } =
    await import("../../src/transcript/CodeTurnError");
  const cases: [string, string][] = [
    ["unexpected status 529: Overloaded", "Service is busy"],
    ["unexpected status 503 Service Unavailable", "Server error"],
    ["429 Too Many Requests", "Server is temporarily limiting requests"],
    ["stream disconnected before completion", "The response stopped arriving"],
    ["error sending request: ECONNRESET", "Connection lost"],
    ["401 Unauthorized", "Authentication failed"],
    ["something odd", "Something went wrong"],
  ];
  for (const [error, headline] of cases)
    assert.equal(codeFailure(error).headline, headline, error);
  const card = renderToStaticMarkup(
    createElement(CodeTurnError, {
      failure: codeFailure("ECONNREFUSED"),
      buttons: [{ label: "Try again", onClick: () => {} }],
    }),
  );
  assert.match(card, /role="alert"/);
  assert.match(card, /Connection lost/);
  assert.match(
    card,
    /Check your internet connection, VPN, or proxy and try again\./,
  );
  assert.match(card, />Try again</);
  const earlier = renderToStaticMarkup(
    createElement(CodeTurnError, {
      failure: codeFailure("ECONNREFUSED"),
      buttons: [],
    }),
  );
  assert.match(earlier, /then send a message to try again\./);
  assert.doesNotMatch(earlier, /<button/);
});
