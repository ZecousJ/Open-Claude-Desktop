import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { isStartupPaint, readStartupPaint } from "../../src-web/official/startup-paint";

test("startup sections become visible independently of the composer", () => {
  const dom = new JSDOM('<aside data-testid="sidebar"><a data-nav-item="projects">Projects</a></aside><header role="toolbar" data-testid="chat-header"></header>');
  const { document, HTMLElement } = dom.window;
  HTMLElement.prototype.checkVisibility = function () {
    return !this.hidden && this.style.display !== "none" && this.style.visibility !== "hidden";
  };
  Object.defineProperty(document, "fonts", { value: { check: () => true } });
  assert.deepEqual(readStartupPaint(document, true, false).ready, ["sidebar", "header"]);
  document.body.insertAdjacentHTML("beforeend", '<div data-testid="transcript-list"></div>');
  assert.deepEqual(readStartupPaint(document, true, false).ready, ["sidebar", "header", "content"]);
  document.body.insertAdjacentHTML("beforeend", '<div class="rounded-composer"><div hidden data-testid="chat-input"></div></div>');
  assert.equal(readStartupPaint(document, true, false).ready.includes("composer"), false);
  document.querySelector<HTMLElement>('[data-testid="chat-input"]')!.hidden = false;
  const painted = readStartupPaint(document, true, false);
  assert.deepEqual(painted.ready, ["sidebar", "header", "content", "composer"]);
  assert.ok(isStartupPaint(painted));
  dom.window.close();
});

test("a collapsed sidebar does not hold the mobile startup", () => {
  const dom = new JSDOM('<div data-testid="chat-input"></div>');
  dom.window.HTMLElement.prototype.checkVisibility = () => true;
  Object.defineProperty(dom.window.document, "fonts", { value: { check: () => true } });
  assert.deepEqual(readStartupPaint(dom.window.document, false, true).ready, ["sidebar", "header", "content", "composer"]);
  assert.equal(isStartupPaint({ type: "claudex:official-boot-progress", ready: ["unknown"], sidebarWidth: null, composerTop: null }), false);
  dom.window.close();
});
