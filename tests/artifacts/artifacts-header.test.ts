import test from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ArtifactChrome } from "../../src/artifacts/ArtifactChrome";
const artifact = {
  id: "header-data",
  name: "Literal <heading>",
  language: "html",
  content: "<p>Actual artifact</p>",
};
const noop = () => {};
function markup(extra: Partial<Parameters<typeof ArtifactChrome>[0]> = {}) {
  return parseHTML(
    renderToStaticMarkup(
      h(ArtifactChrome, {
        artifact,
        expanded: true,
        onExpand: noop,
        onClose: noop,
        onRefresh: noop,
        onError: noop,
        ...extra,
      }),
    ),
  ).document;
}

test("actual artifact option identity follows the displayed version and preserves no-version fallback", () => {
  for (const version of [2, 3]) {
    const d = markup({ versions: 4, shownVersion: version });
    assert.equal(
      d.querySelector(".artifact-title-options")?.getAttribute("aria-label"),
      `Artifact options, Literal <heading>, Version ${version}`,
    );
  }
  assert.equal(
    markup()
      .querySelector(".artifact-title-options")
      ?.getAttribute("aria-label"),
    "Artifact options, Literal <heading>",
  );
  assert.equal(
    markup({ versions: 4, shownVersion: 4 })
      .querySelector(".artifact-title-options")
      ?.getAttribute("aria-label"),
    "Artifact options, Literal <heading>",
  );
  assert.equal(
    markup({ versions: 1, shownVersion: 1 }).querySelector(
      ".artifact-viewing-version",
    ),
    null,
  );
  assert.equal(
    markup({ versions: 4, shownVersion: 2 }).querySelector(
      ".artifact-viewing-version",
    )?.textContent,
    "Version 2",
  );
});

test("standalone header renders actual current-user initials and Home, without adding an avatar to embedded chrome", () => {
  const d = markup({
    standalone: true,
    onHome: noop,
    authorName: "Actual reader",
  });
  const avatar = d.querySelector(".artifact-current-user");
  assert.equal(avatar?.getAttribute("aria-label"), "You");
  assert.equal(avatar?.getAttribute("title"), "Actual reader");
  assert.equal(avatar?.textContent, "A");
  assert.equal(
    d.querySelector('a[aria-label="Home"]')?.getAttribute("href"),
    "/new",
  );
  const controls = [
    ...d.querySelector(".artifact-collaboration-controls")!.children,
  ];
  assert.ok(
    controls.indexOf(avatar!) <
      controls.findIndex((e) =>
        e.classList.contains("artifact-comment-anchor"),
      ),
  );
  assert.ok(
    controls.findIndex((e) => e.classList.contains("artifact-comment-anchor")) <
      controls.findIndex((e) => e.classList.contains("artifact-chat-group")),
  );
  assert.equal(
    markup({ authorName: "Actual reader" }).querySelector(
      ".artifact-current-user",
    ),
    null,
  );
  assert.equal(markup().querySelector('a[aria-label="Home"]'), null);
});

test("multi-file active title carries the same older-version context without relabeling inactive files", () => {
  const d = markup({
    versions: 4,
    shownVersion: 2,
    siblings: () => [
      artifact,
      { ...artifact, id: "other", name: "Other file" },
    ],
    onSwitch: noop,
  });
  assert.equal(
    d
      .querySelector('[role="tab"][aria-selected="true"]')
      ?.getAttribute("aria-label"),
    "Artifact options, Literal <heading>, Version 2",
  );
  assert.equal(
    d.querySelector(".artifact-viewing-version")?.textContent,
    "Version 2",
  );
});
