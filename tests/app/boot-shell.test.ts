/** The HTML and React boot surfaces keep the themed background only. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

registerHooks({
  load(url, context, next) {
    if (url.endsWith(".css"))
      return { format: "module", source: "", shortCircuit: true };
    return next(url, context);
  },
});

const { BootShell } = await import("../../src/boot/BootShell");
const { bootNewChat, bootTheme, bootGreeting } =
  await import("../../src/boot/boot-hints");
const html = readFileSync(new URL("../../web.html", import.meta.url), "utf8");

/** Markup as the browser reads it: Prettier's line breaks, attribute case and spacing aside. */
const canonical = (markup: string) => markup.replace(/\s+/g, "").toLowerCase();

test("web.html paints BootShell's markup before the scripts run", () => {
  const between = /<!-- boot:start -->([\s\S]*)<!-- boot:end -->/.exec(html);
  assert.ok(between, "web.html marks the static first paint");
  assert.equal(
    canonical(between[1]),
    canonical(renderToStaticMarkup(createElement(BootShell))),
  );
});

test("the first paint keeps only the background until the real page is ready", () => {
  const markup = renderToStaticMarkup(createElement(BootShell));
  assert.match(markup, /class="boot-shell" aria-busy="true"/);
  assert.doesNotMatch(markup, /textarea|composer|<h1|Loading|LoaderCircle/);
});

test("the HTML restores the matching page and theme before the renderer starts", () => {
  const script =
    /<script nonce="__CSP_NONCE_VALUE__">([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script);
  const cases = [
    {
      hints: { signedIn: true, theme: "dark" },
      path: "/new",
      systemDark: false,
      surface: "workspace",
      theme: "dark",
      color: "#151515",
    },
    {
      hints: { signedIn: true, theme: "light" },
      path: "/new",
      systemDark: true,
      surface: "workspace",
      theme: "light",
      color: "#fcfcfb",
    },
    {
      hints: { signedIn: false, theme: "dark" },
      path: "/new",
      systemDark: false,
      surface: "signin",
      theme: "dark",
      color: "#111111",
    },
    {
      hints: { signedIn: true, theme: "light" },
      path: "/login",
      systemDark: true,
      surface: "signin",
      theme: "light",
      color: "#faf9f5",
    },
    {
      hints: {},
      path: "/new",
      systemDark: false,
      surface: "signin",
      theme: "light",
      color: "#faf9f5",
    },
    {
      hints: { theme: "invalid" },
      path: "/new",
      systemDark: true,
      surface: "signin",
      theme: "dark",
      color: "#111111",
    },
  ];
  for (const item of cases) {
    const dataset: Record<string, string> = {};
    let color = "";
    runInNewContext(script, {
      document: {
        documentElement: { dataset },
        querySelector: () => ({
          setAttribute: (_key: string, value: string) => {
            color = value;
          },
        }),
      },
      localStorage: { getItem: () => JSON.stringify(item.hints) },
      location: { pathname: item.path },
      matchMedia: () => ({ matches: item.systemDark }),
    });
    assert.equal(dataset.bootSurface, item.surface);
    assert.equal(dataset.theme, item.theme);
    assert.equal(color, item.color);
  }
});

test("new-chat addresses exclude conversations and prefilled prompts", () => {
  assert.equal(bootNewChat("/", ""), true);
  assert.equal(bootNewChat("/new", ""), true);
  assert.equal(bootNewChat("/new/", "?incognito=1"), true);
  assert.equal(
    bootNewChat("/new", "?q=hello"),
    false,
    "a prompt waits for the app",
  );
  assert.equal(bootNewChat("/chat/abc", ""), false);
  assert.equal(bootNewChat("/settings", ""), false);
});

test("the theme: the setting, the system's for system and for a first visit", () => {
  assert.equal(bootTheme("light", true), "light");
  assert.equal(bootTheme("dark", false), "dark");
  assert.equal(bootTheme("system", true), "dark");
  assert.equal(bootTheme("system", false), "light");
  assert.equal(bootTheme(undefined, true), "dark");
  assert.equal(bootTheme(undefined, false), "light");
});

test("the cached greeting is painted only in the time of day it was chosen for", () => {
  const hints = {
    greeting: { slot: "Good morning", roll: 0.4, text: "早上好，Ann" },
  };
  assert.equal(bootGreeting(hints, 9, "")?.text, "早上好，Ann");
  assert.equal(bootGreeting(hints, 14, ""), undefined, "afternoon now");
  assert.equal(bootGreeting(hints, 9, "?incognito=1"), undefined);
  assert.equal(bootGreeting({}, 9, ""), undefined);
});
