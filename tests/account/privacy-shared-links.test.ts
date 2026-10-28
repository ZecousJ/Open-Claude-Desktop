import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HostedShare } from "../../shared/sharing-api";
import {
  removedDetail,
  sharedArtifactsNote,
  sharedChatAudience,
  sharedDate,
  showsSharedChats,
} from "../../src/settings/tabs/Privacy";
import {
  SharedArtifactsTable,
  SharedChatsTable,
} from "../../src/settings/tabs/PrivacyShared";
import { toastName } from "../../src/settings/undoable-remove";

const status = {
  conversations: true,
  artifacts: true,
  maxSnapshotBytes: 1,
  maxArtifactBytes: 1,
};

function share(fields: Partial<HostedShare> = {}): HostedShare {
  return {
    id: "7",
    kind: "conversation",
    sourceKey: "conv-1",
    title: "Trip plan",
    url: "https://share.example.test/s/abc",
    createdAt: new Date(2026, 8, 26, 12).getTime(),
    snapshotAt: new Date(2026, 8, 26, 12).getTime(),
    status: "active",
    views: 12,
    ...fields,
  };
}

const noop = () => {};

test("Shared chats shows only while the service hosts shared chats", () => {
  assert.equal(showsSharedChats(undefined), false);
  assert.equal(showsSharedChats(null), false);
  assert.equal(showsSharedChats(status), true);
  assert.equal(
    showsSharedChats({ ...status, conversations: false, artifacts: true }),
    false,
  );
  // Blocked accounts can still list and stop their links.
  assert.equal(
    showsSharedChats({
      ...status,
      conversations: false,
      artifacts: false,
      blocked: true,
    }),
    true,
  );
});

test("dates, audience lines and toast names read as the live page's", () => {
  assert.equal(sharedDate(new Date(2026, 8, 26).getTime()), "Sep 26, 2026");
  assert.equal(sharedDate(undefined), "—");
  assert.equal(sharedChatAudience(share()), "Anyone with the link");
  assert.equal(
    sharedChatAudience(share({ access: "invited" })),
    "Only people invited",
  );
  assert.equal(
    sharedChatAudience(share({ status: "disabled" })),
    "Removed by the administrator",
  );
  assert.equal(
    removedDetail(share({ status: "disabled", disabledReason: "Spam" })),
    "Removed by the administrator: Spam",
  );
  assert.equal(toastName("short"), "short");
  assert.equal(toastName("x".repeat(40)), `${"x".repeat(31)}…`);
});

test("the Shared chats table: loading, error, empty and rows", () => {
  const props = {
    canOpenChat: (s: HostedShare) => s.sourceKey === "conv-1",
    onOpenShare: noop,
    onOpenChat: noop,
    onUnshare: noop,
  };
  const render = (items: HostedShare[] | undefined, failed = false) =>
    renderToStaticMarkup(
      createElement(SharedChatsTable, { ...props, items, failed }),
    );
  assert.match(render(undefined), /aria-busy="true"/);
  assert.match(render(undefined, true), /Error loading shared content/);
  assert.match(render([]), /No shared content found/);
  const html = render([
    share(),
    share({
      id: "8",
      title: "Old",
      status: "disabled",
      url: "",
      sourceKey: "",
    }),
  ]);
  assert.match(html, /Name.*Date shared.*Location.*Unshare/s);
  assert.match(html, /Trip plan/);
  assert.match(html, /Sep 26, 2026/);
  assert.match(html, /Anyone with the link/);
  assert.match(html, /Open chat/);
  assert.match(html, /Unshare Trip plan/);
  assert.match(html, /Removed by the administrator/);
  assert.match(html, /Unshare Old/);
  const unnamed = render([share({ title: "" })]);
  assert.match(unnamed, /title="Untitled Conversation"/);
  assert.match(unnamed, /Unshare Untitled Conversation/);
  // No views, copy buttons or menus: the live table has none.
  assert.doesNotMatch(html, /views|Copy link|More options/);
});

test("the Shared artifacts table says where each link opens", () => {
  assert.match(sharedArtifactsNote(false), /only on this computer/);
  assert.match(sharedArtifactsNote(true), /public/);
  const html = renderToStaticMarkup(
    createElement(SharedArtifactsTable, {
      items: [
        {
          identity: "hosted:3",
          title: "Deck",
          scope: "public",
          url: "https://x.test/s/1",
          createdAt: new Date(2026, 9, 2).getTime(),
        },
        { identity: "a", title: "Chart", scope: "local" },
      ],
      failed: false,
      onOpen: noop,
      onUnpublish: noop,
    }),
  );
  assert.match(html, /Date published/);
  assert.match(html, /Deck.*Oct 2, 2026.*Public.*Chart.*—.*This computer/s);
  assert.match(html, /Unpublish Deck/);
  assert.match(
    renderToStaticMarkup(
      createElement(SharedArtifactsTable, {
        items: [],
        failed: false,
        onOpen: noop,
        onUnpublish: noop,
      }),
    ),
    /No shared content found/,
  );
});
