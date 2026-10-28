import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { EditSidebarDialog } from "../../src/sidebar/EditSidebarDialog";
import {
  isFixedNavItem,
  sidebarNav,
  toggleNavItem,
} from "../../src/sidebar/navItems";
import { profileInitials } from "../../src/sidebar/profile";
import { ConversationList } from "../../src/sidebar/ConversationList";
import { AccountMenu } from "../../src/sidebar/AccountMenu";
import { readSource } from "../support/read-source";

test("the account fallback uses the first and last initials, including Unicode", () => {
  assert.equal(profileInitials("Ada Lovelace"), "AL");
  assert.equal(profileInitials("  ada middle lovelace  "), "AL");
  assert.equal(profileInitials("李 明"), "李明");
  assert.equal(profileInitials("🦊 Example"), "🦊E");
  assert.equal(profileInitials("Ada"), "A");
  assert.equal(profileInitials("  "), "?");
});

test("unified home's fixed collection rows include Scheduled in Code; other Code rows remain editable, API and Service status stay", () => {
  const hidden = ["projects", "artifacts", "scheduled", "customize", "api"];
  const home = sidebarNav("chat", hidden, true);
  assert.deepEqual(
    home.shown.map((item) => item.id),
    ["projects", "artifacts", "api", "status"],
  );
  assert.deepEqual(
    home.inMore.map((item) => item.id),
    ["scheduled", "customize"],
  );
  assert.equal(isFixedNavItem("cowork", "projects", true), true);
  assert.equal(isFixedNavItem("code", "artifacts", true), false);
  assert.equal(isFixedNavItem("code", "scheduled", true), false);
  assert.equal(isFixedNavItem("chat", "projects", false), true);
  // API and Service status always sit on the sidebar.
  assert.equal(isFixedNavItem("chat", "api", true), true);
  assert.equal(isFixedNavItem("code", "status", false), true);
  assert.deepEqual(toggleNavItem(hidden, "projects", false, true), hidden);
  assert.deepEqual(
    sidebarNav("code", hidden, true).inMore.map((item) => item.id),
    ["artifacts", "scheduled", "customize"],
  );
});

test("Edit sidebar marks fixed rows checked and disabled, with Done as initial focus", () => {
  const render = (mode: "chat" | "code") => {
    const html = renderToStaticMarkup(
      createElement(EditSidebarDialog, {
        mode,
        hidden: ["projects", "artifacts"],
        onChange() {},
        onClose() {},
      }),
    );
    return parseHTML(html).document;
  };
  const home = render("chat");
  const fixed = [...home.querySelectorAll<HTMLInputElement>("input:disabled")];
  // Projects, Artifacts, API and Service status.
  assert.equal(fixed.length, 4);
  assert.ok(fixed.every((input) => input.hasAttribute("checked")));
  assert.equal(home.querySelector("button[autofocus]")?.textContent, "Done");
  assert.equal(render("code").querySelectorAll("input:disabled").length, 2);
});

test("desktop card geometry and body spacing are independent from the web and collapsed layouts", () => {
  const css = readSource(
    new URL("../../src/sidebar/sidebar.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.app:not\(\.web\):not\(\.sidebar-hidden\) \.sidebar \{[^}]*top: calc\(8px \+ var\(--sidebar-chrome-height\)\)[^}]*bottom: 8px[^}]*inset-inline-start: 8px[^}]*border-radius: 8px[^}]*box-shadow:/s,
  );
  assert.match(
    css,
    /\.sidebar-body \{[^}]*gap: 8px;[^}]*padding: 12px 8px 6px;/s,
  );
  assert.match(
    css,
    /\.app:not\(\.web\)\.sidebar-hidden \{[^}]*column-gap: 0;/s,
  );
  assert.doesNotMatch(css, /margin-top: (23|33)px/);
});

test("Recents has no All chats or search action; only Code gets the filter", () => {
  const render = (mode: "chat" | "code") =>
    parseHTML(
      renderToStaticMarkup(
        createElement(ConversationList, {
          mode,
          page: "chat",
          conversations: [],
          projects: [],
          approvalIds: new Set<string>(),
          onPageChange() {},
          async onReorder() {},
          onError() {},
          onOpen() {},
          onRename() {},
          onMoveToProject() {},
          onToggleArchive() {},
          onDelete() {},
          onToggleUnread() {},
          onOpenIn() {},
        }),
      ),
    ).document;
  const home = render("chat");
  const heading = home.querySelector(".recent-label")!;
  assert.equal(heading.querySelectorAll("button").length, 2);
  assert.ok(heading.querySelector('[aria-label="Filter and group recents"]'));
  assert.equal(
    heading.querySelector("button")?.getAttribute("aria-expanded"),
    "true",
  );
  assert.equal(heading.querySelector("button")?.textContent, "Recents");
  assert.equal(
    render("code").querySelectorAll(".recent-label button").length,
    2,
  );
});

test("desktop account keeps the display name and search alongside the two-initial avatar", () => {
  const html = renderToStaticMarkup(
    createElement(AccountMenu, {
      mode: "chat",
      name: "Ada Lovelace",
      onSearch() {},
      onSettings() {},
      onUsage() {},
      onChangelog() {},
      onError() {},
    }),
  );
  const document = parseHTML(html).document;
  assert.equal(document.querySelector(".avatar")?.textContent, "AL");
  assert.match(
    document.querySelector(".profile")?.textContent ?? "",
    /Ada Lovelace/,
  );
  assert.ok(document.querySelector(".account-search"));
});
