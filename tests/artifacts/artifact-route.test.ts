import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { Artifact } from "../../src/ui/ArtifactTypes";
import {
  artifactRouteId,
  artifactRoutePath,
  findRoutedArtifact,
} from "../../src/artifacts/artifact-route-model";
import { ArtifactOpenLink } from "../../src/artifacts/ArtifactOpenLink";
import {
  formatWebRoute,
  initialWebEntry,
  navEntryForRoute,
  parseWebRoute,
  routeForNavEntry,
  urlForState,
} from "../../src/web/routes";
import { applyRoute } from "../../src/web/web-route-apply";
import type { AppController } from "../../src/app/AppContext";
import { sameEntry } from "../../src/app/navigation-history";
import { mergeRoutedCopy } from "../../src/artifacts/refresh-routed-copy";
import type { ArtifactLibraryState, SavedArtifact } from "../../shared/types";

const source: Artifact = {
  id: "message-1-0",
  conversationId: "test-conversation",
  sourcePath: "/private/file.html",
  name: "private name",
  content: "private body",
  language: "html",
};

test("artifact addresses contain an opaque stable ID and no body, name or source path", () => {
  const id = artifactRouteId(source);
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.equal(artifactRoutePath(source), `/artifact/${id}`);
  assert.equal(
    artifactRouteId({ ...source, name: "renamed", content: "rewritten" }),
    id,
  );
  assert.notEqual(artifactRouteId({ ...source, conversationId: "other" }), id);
  assert.notEqual(artifactRouteId({ ...source, libraryId: "copy-1" }), id);
  assert.notEqual(
    artifactRouteId({ ...source, libraryId: "copy-1" }),
    artifactRouteId({ ...source, libraryId: "copy-2" }),
  );
  const inline = { ...source, sourcePath: undefined };
  assert.equal(
    artifactRouteId(inline),
    artifactRouteId({ ...inline, content: "changed", name: "different" }),
  );
});

test("lookup only considers the supplied account library, rejects missing and ambiguous records", () => {
  const other = { ...source, conversationId: "another-account-session" };
  assert.equal(findRoutedArtifact([source], artifactRouteId(source)), source);
  assert.equal(findRoutedArtifact([other], artifactRouteId(source)), undefined);
  assert.equal(findRoutedArtifact([], artifactRouteId(source)), undefined);
  assert.equal(
    findRoutedArtifact(
      [source, { ...source, name: "ambiguous" }],
      artifactRouteId(source),
    ),
    undefined,
  );
});

test("refreshing an imported routed copy preserves concurrent pins, other copies and its provenance", () => {
  const copy = {
    libraryId: "imported",
    sharedArtifactToken: "token",
    name: "Old",
    language: "html",
    content: "old",
    createdAt: 1,
  } as SavedArtifact;
  const other = { ...copy, libraryId: "other", content: "a concurrent edit" };
  const current: ArtifactLibraryState = {
    version: 1,
    copies: [copy, other],
    pinned: ["a-new-pin"],
  };
  const next = mergeRoutedCopy(current, copy.libraryId, "token", {
    ...copy,
    content: "fresh",
    name: "Fresh",
    createdAt: 9,
  });
  assert.deepEqual(next.pinned, ["a-new-pin"]);
  assert.equal(next.copies[1], other);
  assert.equal(next.copies[0].createdAt, 1);
  assert.equal(next.copies[0].content, "fresh");
  assert.equal(next.copies[0].sharedArtifactToken, "token");
  assert.equal(current.copies[0].content, "old");
});

test("late imported-copy refresh cannot restore deletion, a changed token, or a different ID", () => {
  const copy = {
    libraryId: "imported",
    sharedArtifactToken: "token",
    name: "Old",
    language: "html",
    content: "old",
    createdAt: 1,
  } as SavedArtifact;
  const current: ArtifactLibraryState = {
    version: 1,
    copies: [copy],
    pinned: [],
  };
  const deleted = { ...current, copies: [] };
  assert.equal(
    mergeRoutedCopy(deleted, copy.libraryId, "token", copy),
    deleted,
  );
  assert.equal(
    mergeRoutedCopy(current, copy.libraryId, "changed", copy),
    current,
  );
  assert.equal(mergeRoutedCopy(current, "different", "token", copy), current);
  assert.equal(
    mergeRoutedCopy(current, copy.libraryId, "token", {
      ...copy,
      content: undefined,
    } as unknown as SavedArtifact),
    current,
  );
});

test("standalone routes round-trip and preserve their identity in browser/application history", () => {
  const id = artifactRouteId(source),
    route = { kind: "artifact" as const, id };
  assert.deepEqual(parseWebRoute(`/artifact/${id}`), route);
  assert.deepEqual(parseWebRoute("/artifact/missing"), {
    kind: "artifact",
    id: "missing",
  });
  assert.equal(formatWebRoute(route), `/artifact/${id}`);
  assert.equal(
    urlForState({ page: "artifact", mode: "code", artifactId: id }),
    `/artifact/${id}`,
  );
  const entry = navEntryForRoute(route)!;
  assert.deepEqual(initialWebEntry(route), entry);
  assert.deepEqual(
    initialWebEntry({ kind: "settings", tab: "general", background: route }),
    entry,
  );
  assert.deepEqual(routeForNavEntry(entry), route);
  assert.equal(
    sameEntry(entry, { ...entry, artifactId: "0".repeat(32) }),
    false,
  );
  for (const value of ["../new", "%2fnew", "!bad", "0".repeat(129)])
    assert.equal(parseWebRoute(`/artifact/${value}`).kind, "not-found", value);
});

test("applying an artifact address updates its ID, mode and page without treating it as a new chat", () => {
  const calls: unknown[] = [];
  const app = {
    page: "artifacts",
    mode: "code",
    search: null,
    settingsOpen: false,
    setArtifactRouteId: (id: string) => calls.push(["id", id]),
    setMode: (mode: string) => calls.push(["mode", mode]),
    setPage: (page: string) => calls.push(["page", page]),
    newChat: () => {
      throw Error("must not start a conversation");
    },
  } as unknown as AppController;
  const id = artifactRouteId(source);
  assert.equal(
    applyRoute(
      app,
      { kind: "artifact", id },
      { codeAvailable: true, initial: true },
    ),
    `/artifact/${id}`,
  );
  assert.deepEqual(calls, [
    ["id", id],
    ["mode", "chat"],
    ["page", "artifact"],
  ]);
});

test("web artifact openers are real links and native openers retain button semantics", () => {
  const props = { className: "test", onOpen() {}, children: "Open" };
  assert.match(
    renderToStaticMarkup(
      createElement(ArtifactOpenLink, {
        ...props,
        href: artifactRoutePath(source),
      }),
    ),
    /^<a href="\/artifact\//,
  );
  assert.match(
    renderToStaticMarkup(createElement(ArtifactOpenLink, props)),
    /^<button type="button"/,
  );
});

test("plain clicks navigate within the app; modified clicks retain native browser link handling", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const globals = { window, document, IS_REACT_ACT_ENVIRONMENT: true };
  const old = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  let opened = 0;
  try {
    await act(() =>
      root.render(
        createElement(ArtifactOpenLink, {
          href: artifactRoutePath(source),
          className: "test",
          children: "Open",
          onOpen: () => opened++,
        }),
      ),
    );
    for (const modified of [
      "metaKey",
      "ctrlKey",
      "shiftKey",
      "altKey",
      "middle",
      "plain",
    ]) {
      const event = new window.Event("click", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "button", {
        value: modified === "middle" ? 1 : 0,
      });
      if (!["middle", "plain"].includes(modified))
        Object.defineProperty(event, modified, { value: true });
      await act(() => document.querySelector("a")!.dispatchEvent(event));
      assert.equal(event.defaultPrevented, modified === "plain", modified);
    }
    assert.equal(opened, 1);
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of old)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
