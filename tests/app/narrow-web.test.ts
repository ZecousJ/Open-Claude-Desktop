/**
 * The web app at narrow and phone widths: where the sidebar becomes a drawer,
 * how a swipe closes the phone sheet, and the CSS that turns menus into bottom
 * sheets on a touch phone, keeps dialogs 16px from the edges and gives the Chat
 * transcript its 20px sides.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  collapseThreshold,
  collapseWidth,
  initialVisibility,
  peekRequested,
  resizeVisibility,
  showSidebar,
  sidebarOpen,
  toggleVisibility,
  webSheetWidth,
} from "../../src/sidebar/sidebar-visibility";
import { bootSidebarNarrow, bootSidebarWidth } from "../../src/boot/boot-hints";
import { swipeCloses, swipeStarts, swipeSlop } from "../../src/ui/swipe-close";
import { readSource } from "../support/read-source";

test("the collapse line is max(700px, width + 329px), never past 749px", () => {
  assert.equal(collapseThreshold(), 700);
  assert.equal(collapseThreshold(288), 700);
  assert.equal(collapseThreshold(371), 700);
  assert.equal(collapseThreshold(372), 701);
  assert.equal(collapseThreshold(400.2), 730);
  assert.equal(collapseThreshold(420), 749);
  assert.equal(collapseThreshold(460), 749);
  assert.equal(collapseWidth(), 701);
  assert.equal(collapseWidth(400), 730);
  // A wider stored sidebar collapses a window that a default one keeps.
  const wide = initialVisibility(720, 288, true);
  assert.equal(sidebarOpen(wide), true);
  const wider = resizeVisibility(wide, 720, 400, true);
  assert.equal(wider.narrow, true);
  assert.equal(sidebarOpen(wider), false);
  assert.equal(sidebarOpen(resizeVisibility(wider, 731, 400, true)), true);
});

test("between a phone's width and the line the toggle asks for the peek", () => {
  assert.equal(webSheetWidth, 640);
  let state = initialVisibility(680, 288, true);
  assert.equal(state.narrow, true);
  assert.equal(state.phone, false);
  assert.equal(sidebarOpen(state), false);
  state = toggleVisibility(state);
  assert.equal(sidebarOpen(state), false, "the column never opens there");
  assert.equal(peekRequested(state), true);
  assert.equal(showSidebar(state), state, "showing an open peek keeps it");
  assert.equal(peekRequested(toggleVisibility(state)), false);
  // Below 640px the toggle opens the phone's sheet instead.
  let phone = initialVisibility(500, 288, true);
  assert.equal(phone.phone, true);
  phone = toggleVisibility(phone);
  assert.equal(sidebarOpen(phone), true);
  assert.equal(peekRequested(phone), false);
  // Crossing into the phone band forgets the peek.
  assert.equal(peekRequested(resizeVisibility(state, 600, 288, true)), false);
  // The desktop has no phone band: narrow is always the peek.
  assert.equal(initialVisibility(620, 288, false).phone, false);
});

test("the remembered width uses the same sidebar collapse threshold", () => {
  assert.equal(bootSidebarWidth({ sidebarWidth: 400 }), 400);
  assert.equal(bootSidebarWidth({ sidebarWidth: 500 }), undefined);
  assert.equal(bootSidebarWidth({ sidebarWidth: 300.5 }), undefined);
  assert.equal(bootSidebarNarrow({}, 700), true);
  assert.equal(bootSidebarNarrow({}, 701), false);
  assert.equal(bootSidebarNarrow({ sidebarWidth: 400 }, 728), true);
  assert.equal(bootSidebarNarrow({ sidebarWidth: 400 }, 729), true);
  assert.equal(bootSidebarNarrow({ sidebarWidth: 400 }, 730), false);
});

test("a swipe starts only past the slop, leftwards and more left than up or down", () => {
  assert.equal(swipeSlop, 10);
  assert.equal(swipeStarts(5, 3), undefined);
  assert.equal(swipeStarts(12, 4), true);
  assert.equal(swipeStarts(12, 12), true);
  assert.equal(swipeStarts(12, 13), false);
  assert.equal(swipeStarts(-12, 0), false);
  assert.equal(swipeStarts(0, 20), false);
});

test("a let-go swipe closes past a third of the sheet or faster than 0.5 px/ms", () => {
  assert.equal(swipeCloses(126, 1000, 375), true);
  assert.equal(swipeCloses(124, 1000, 375), false);
  assert.equal(swipeCloses(60, 100, 375), true);
  assert.equal(swipeCloses(40, 100, 375), false);
  assert.equal(swipeCloses(10, 0, 375), true);
});

test("menus become bottom sheets on a touch phone, behind a scrim", () => {
  const css = readSource("src/ui/menu.css", "utf8");
  const sheet = css.slice(css.indexOf(".menu-sheet-scrim {"));
  assert.match(
    sheet,
    /@media \(pointer: coarse\) and \(max-width: 639\.98px\)/,
  );
  assert.match(sheet, /border-radius: 12px 12px 0 0/);
  assert.match(sheet, /max-height: 90dvh/);
  assert.match(sheet, /max\(env\(safe-area-inset-bottom\), 8px\)/);
  assert.match(sheet, /0\.3s cubic-bezier\(0\.165, 0\.84, 0\.44, 1\)/);
  assert.match(sheet, /height: 40px/);
  const menu = readSource("src/ui/Menu.tsx", "utf8");
  assert.match(menu, /className="menu-sheet-scrim" aria-hidden="true"/);
  assert.match(menu, /data-submenu=""/);
});

test("web dialogs, drawer and Chat transcript follow the live narrow rules", () => {
  const css = readSource("src/styles/95-web.css", "utf8");
  // The fixed-position sidebar is the phone's sheet only; the line above it
  // follows the stored width in sidebar-visibility.ts.
  assert.match(css, /@media \(max-width: 639\.98px\) \{\n  \.app\.web,/);
  assert.doesNotMatch(css, /@media \(max-width: 700px\)/);
  assert.doesNotMatch(css, /background: #00000080/, "no scrim");
  assert.doesNotMatch(css, /max-width: 767\.98px\) \{\n  \.app\.web,/);
  assert.match(css, /:where\(:root\[data-surface="web"\]\) \.overlay/);
  assert.match(
    css,
    /100dvh - 32px - 2 \*\s+max\(env\(safe-area-inset-top\), env\(safe-area-inset-bottom\)\)/,
  );
  const footer = css.slice(css.indexOf("a dialog's buttons stack"));
  assert.match(
    footer,
    /flex-direction: column-reverse;\s+align-items: stretch;/,
  );
  const transcript = css.slice(css.indexOf("Below 768px the Chat transcript"));
  assert.match(transcript, /padding-left: 20px;\s+padding-right: 20px;/);
  assert.match(css, /transform 0\.3s cubic-bezier\(0\.165, 0\.84, 0\.44, 1\)/);
  const boot = readSource("src/boot/boot.css", "utf8");
  assert.match(boot, /\.boot-shell \{\s+min-height: 100dvh;/);
});

test("phone incognito keeps its workspace out of the zero-width sidebar column", () => {
  const css = readSource("src/incognito/incognito.css", "utf8");
  assert.match(
    css,
    /\.app\.web\.incognito-app\.sidebar-hidden \{\s+grid-template-columns: minmax\(0, 1fr\);/,
  );
  assert.match(css, /\.app\.incognito-app > \.workspace \{\s+grid-column: 1;/);
});

test("above a phone's width the web's collapsed sidebar is the peek panel", () => {
  const css = readSource("src/sidebar/sidebar.css", "utf8");
  const peek = css.slice(css.indexOf("The web's peek"));
  assert.match(peek, /@media \(min-width: 640px\)/);
  assert.match(peek, /width: var\(--sidebar-peek-width, 288px\)/);
  assert.match(peek, /transform: translateX\(-4px\)/);
  assert.match(
    peek,
    /opacity 140ms ease,\s+transform 180ms var\(--ease-snap\)/,
  );
  assert.match(peek, /border-right: 0\.5px solid/);
  const sidebar = readSource("src/app/AppSidebar.tsx", "utf8");
  assert.match(sidebar, /!sidebar && !incognitoShown && !sidebarView\.phone/);
  const hook = readSource("src/sidebar/useSidebarPeek.ts", "utf8");
  // A finger lifting must not close it; a press outside does.
  assert.match(
    hook,
    /if \(event\.pointerType !== "mouse"\) return;\s+stopDwell/,
  );
  assert.match(
    hook,
    /addEventListener\("pointerdown", press, \{ capture: true \}\)/,
  );
});
