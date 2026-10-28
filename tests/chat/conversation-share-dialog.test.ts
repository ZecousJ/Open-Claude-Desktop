import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConversationShareView,
  publicDescription,
  shareDate,
  shareDialogText,
  type ShareDialogState,
} from "../../src/conversation/ConversationShareDialog";
import type { HostedShare, SharingStatus } from "../../shared/sharing-api";
import type { Conversation } from "../../shared/types";

const status: SharingStatus = {
  conversations: true,
  artifacts: true,
  usagePolicyUrl: "https://share.example.test/policy",
  maxSnapshotBytes: 1,
  maxArtifactBytes: 1,
};
const share: HostedShare = {
  id: "1",
  kind: "conversation",
  sourceKey: "c1",
  title: "Synthetic",
  url: "https://share.example.test/s/abc",
  createdAt: Date.UTC(2026, 8, 26),
  snapshotAt: Date.UTC(2026, 8, 26, 12),
  status: "active",
};
const target = {
  id: "c1",
  title: "Synthetic",
  mode: "code" as const,
  cwd: "/tmp/repo",
};
const noop = () => undefined;
function view(
  state: Partial<ShareDialogState>,
  sharing: SharingStatus = status,
  mode: Conversation["mode"] = "code",
) {
  return renderToStaticMarkup(
    createElement(ConversationShareView, {
      conversation: { ...target, mode },
      status: sharing,
      state: {
        share: null,
        busy: false,
        confirmStop: false,
        copied: false,
        repository: false,
        ...state,
      },
      onPublic: noop,
      onPrivate: noop,
      onStop: noop,
      onCancelStop: noop,
      onCopy: noop,
      onUpdate: noop,
      onUsagePolicy: noop,
    }),
  );
}

test("chat and session dialogs are titled like the original", () => {
  assert.equal(shareDialogText("chat").title, "Share session");
  assert.equal(shareDialogText("code").title, "Share session");
  assert.equal(shareDialogText("cowork").title, "Share session");
  assert.match(view({}, status, "code"), /how you code with Claudex/);
});

test("Code uses Private/Public and Share visibility, not the general-chat Keep private/Create public link copy", () => {
  const html = view({});
  assert.match(html, /aria-label="Share visibility"/);
  assert.match(html, />Private</);
  assert.match(html, />Public</);
  assert.ok(!html.includes("Keep private"));
  assert.ok(!html.includes("Create public link"));
});

test("private: Private is chosen, no link, the administrator's Usage Policy", () => {
  const html = view({});
  assert.match(html, /role="radio" aria-checked="true"/);
  assert.match(html, /class="share-option selected"/);
  assert.match(html, /Only you have access/);
  assert.match(html, /Anyone with the link can view/);
  assert.doesNotMatch(html, /Copy link/);
  assert.match(
    html,
    /href="https:\/\/share.example.test\/policy"[^>]*>Usage Policy/,
  );
  assert.doesNotMatch(html, /local repository/);
});

test("loading fades both options and keeps them unavailable", () => {
  const html = view({ share: undefined });
  assert.match(html, /share-options loading/);
  assert.equal(html.match(/aria-disabled="true"/g)?.length, 2);
});

test("the Usage Policy link sits inside one sentence", () => {
  const html = view({});
  assert.match(
    html,
    /without permission, and see our <a [^>]*>Usage Policy<\/a>\./,
  );
});

test("without a Usage Policy the note ends without a link", () => {
  const plain: SharingStatus = { ...status, usagePolicyUrl: undefined };
  const html = view({}, plain);
  assert.doesNotMatch(html, /Usage Policy/);
  assert.match(html, /without permission\.<\/p>/);
});

test("public: the link and Copy link show; Copied after copying", () => {
  const html = view({ share });
  // The link is text that opens in a new tab, beside a primary Copy link.
  assert.match(
    html,
    /class="share-link-open"[^>]*>.*https:\/\/share.example.test\/s\/abc/,
  );
  assert.match(html, /class="share-copy primary"[^>]*>Copy link</);
  const copied = view({ share, copied: true });
  assert.match(copied, /class="share-copy secondary"[^>]*>Copied</);
  assert.doesNotMatch(html, /New messages/);
});

test("a stale link offers Update link", () => {
  const html = view({ share: { ...share, stale: true } });
  assert.match(html, /New messages aren(&#x27;|')t included/);
  assert.match(html, />Update link</);
});

test("while shared the Usage Policy note gives way to the link", () => {
  assert.match(view({}), /Usage Policy/);
  assert.doesNotMatch(view({ share }), /Usage Policy|third-party content/);
  // Private stops the link at once: no confirmation step.
  assert.doesNotMatch(view({ share, confirmStop: true }), /lose access/);
});

test("a link taken down by the administrator has no Copy link", () => {
  const html = view({
    share: { ...share, status: "disabled", disabledReason: "Reported" },
  });
  assert.match(html, /Removed by the administrator/);
  assert.doesNotMatch(html, /Copy link/);
});

test("with Require repository access on, Public says who can view", () => {
  assert.equal(
    publicDescription(status, null, true),
    "Anyone with repository access and the link can view",
  );
  assert.equal(
    publicDescription(status, null),
    "Anyone with the link can view",
  );
  assert.match(
    view({ requireRepositoryAccess: true }),
    /Anyone with repository access and the link can view/,
  );
});

test("a blocked account cannot choose Public but can stop a link", () => {
  const blocked: SharingStatus = {
    ...status,
    conversations: false,
    artifacts: false,
    blocked: true,
  };
  assert.equal(
    publicDescription(blocked, null),
    "Your administrator has turned off sharing for your account.",
  );
  const html = view({}, blocked);
  assert.match(html, /aria-checked="false" aria-disabled="true"/);
  const shared = view({ share: { ...share, stale: true } }, blocked);
  assert.doesNotMatch(shared, /Update link/);
  assert.match(shared, /Copy link/);
});

test("a session in a repository warns that code may be exposed", () => {
  assert.match(
    view({ repository: true }),
    /This session is from a local repository\. Sharing may expose code/,
  );
});

test("dates read like Sep 26, with the year only when it differs", () => {
  const now = new Date(2026, 8, 30).getTime();
  assert.equal(shareDate(new Date(2026, 8, 26).getTime(), now), "Sep 26");
  assert.equal(shareDate(new Date(2025, 0, 2).getTime(), now), "Jan 2, 2025");
});

test("Chat's Copy link works before anything is shared, unless sharing is off", async () => {
  const { copyAllowed } =
    await import("../../src/conversation/ChatSharePopover");
  // Still reading the share: wait.
  assert.equal(copyAllowed(undefined, true), false);
  // Nothing shared: Copy link makes an invited-only link.
  assert.equal(copyAllowed(null, true), true);
  assert.equal(copyAllowed(null, false), false);
  // A live link copies; one taken down by the administrator does not.
  assert.equal(copyAllowed(share, false), true);
  assert.equal(copyAllowed({ ...share, status: "disabled" }, true), false);
});
