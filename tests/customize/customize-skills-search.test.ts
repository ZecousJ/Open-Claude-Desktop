import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import UnifiedSearch, {
  catalogQuery,
  matchesQuery,
  searchSections,
} from "../../src/collections/customize/UnifiedSearch";
import { createCustomizeSearchAdapter } from "../../src/collections/customize/customize-search-adapter";
import { matchingNames } from "../../src/collections/customize/customize-list";
import {
  validCustomizeSearchResult,
  type CustomizeSearchHit,
  type CustomizeSearchRequest,
  type CustomizeSearchResult,
} from "../../shared/customize-search";
import { routineDom } from "../support/routine-dom";
const hit = (id: number): CustomizeSearchHit => ({
  key: `skill:${id}`,
  kind: "skill",
  name: `Alpha ${id}`,
  yours: false,
  target: { type: "skill", path: `/skills/${id}/SKILL.md` },
});
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test("official query threshold and name-only Fuse intersection preserve source order", () => {
  assert.equal(catalogQuery("a---"), "");
  assert.equal(catalogQuery("a1"), "a1");
  assert.equal(catalogQuery("中文"), "中文");
  assert.equal(Array.from(catalogQuery("𐐀".repeat(205))).length, 200);
  const items = ["Spreadsheet notes", "Café_notes", "Notes spreadsheet"];
  assert.deepEqual(
    matchingNames(items, "spredsheet ntes", (item) => item),
    [items[0], items[2]],
  );
  assert.deepEqual(
    matchingNames(items, "cafe notes", (item) => item),
    [items[1]],
  );
  const local = {
    key: "name",
    kind: "skill" as const,
    name: "Notes",
    description: "secret description",
    yours: true,
    open() {},
  };
  assert.equal(matchesQuery(local, "secret"), false);
  assert.equal(searchSections([local], "n", "skills").keepTyping, true);
});

test("mounted cursor search requests actual next page, retains rows on failure and retries the same continuation", async () => {
  const requests: CustomizeSearchRequest[] = [];
  const first = deferred<CustomizeSearchResult>();
  let more = deferred<CustomizeSearchResult>();
  const adapter = createCustomizeSearchAdapter(
    {
      customizeSearch: async (request) => {
        requests.push(request);
        if (request.section !== "inPage") return { items: [], total: 0 };
        return request.cursor ? more.promise : first.promise;
      },
    },
    () => true,
  )!;
  const opened: string[] = [];
  const env = await routineDom({}, { jsdom: true });
  try {
    await env.render(
      h(UnifiedSearch, {
        query: "alpha",
        settledQuery: "alpha",
        page: "skills",
        items: [],
        adapter,
        onOpenResult: (item) => opened.push(item.key),
      }),
    );
    assert.equal(requests.length, 3);
    assert.match(env.document.body.textContent ?? "", /Searching/);
    assert.doesNotMatch(env.document.body.textContent ?? "", /No skills match/);
    await act(async () =>
      first.resolve({
        items: [1, 2, 3, 4, 5].map(hit),
        total: 7,
        nextCursor: "next",
      }),
    );
    assert.equal(env.document.querySelectorAll(".customize-row").length, 5);
    await env.click('button[aria-label="Show more: In Skills"]');
    assert.equal(requests.at(-1)?.cursor, "next");
    assert.equal(requests.at(-1)?.limit, 5);
    assert.match(env.document.body.textContent ?? "", /Loading more/);
    assert.equal(env.document.querySelectorAll(".customize-row").length, 5);
    await act(async () => more.reject(new Error("offline")));
    assert.match(env.document.body.textContent ?? "", /Couldn’t load more/);
    assert.equal(env.document.querySelectorAll(".customize-row").length, 5);
    more = deferred<CustomizeSearchResult>();
    const retry = [...env.document.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    )!;
    await env.event(retry, "click");
    assert.equal(requests.at(-1)?.cursor, "next");
    await act(async () =>
      more.resolve({ items: [5, 6, 7].map(hit), total: 7 }),
    );
    assert.equal(env.document.querySelectorAll(".customize-row").length, 7);
    assert.equal(
      env.document.querySelector('[aria-label="Show more: In Skills"]'),
      null,
    );
    await env.event(
      env.document.querySelector(".customize-row-main")!,
      "click",
    );
    assert.deepEqual(opened, ["skill:1"]);
  } finally {
    await env.clean();
  }
});

test("short queries make no host request; changed query or account discards late host results", async () => {
  let current = true;
  const pending = deferred<CustomizeSearchResult>();
  const calls: CustomizeSearchRequest[] = [];
  const adapter = createCustomizeSearchAdapter(
    {
      customizeSearch: async (request) => {
        calls.push(request);
        return request.query === "old"
          ? pending.promise
          : { items: [], total: 0 };
      },
    },
    () => current,
  )!;
  const env = await routineDom({}, { jsdom: true });
  const render = (query: string) =>
    env.render(
      h(UnifiedSearch, {
        query,
        settledQuery: query,
        page: "skills",
        items: [],
        adapter,
      }),
    );
  try {
    await render("a");
    assert.equal(calls.length, 0);
    assert.match(env.document.body.textContent ?? "", /Keep typing/);
    await render("old");
    assert.equal(calls.length, 3);
    await render("new");
    assert.match(env.document.body.textContent ?? "", /No skills match/);
    current = false;
    await act(async () => pending.resolve({ items: [hit(999)], total: 1 }));
    assert.doesNotMatch(env.document.body.textContent ?? "", /Alpha 999/);
    await assert.rejects(
      adapter.search({ query: "new", page: "skills", section: "yours" }),
      /account changed/,
    );
    assert.equal(calls.length, 6);
  } finally {
    await env.clean();
  }
});

test("typed adapter validates host payloads and never changes a failed host read into a finite success", async () => {
  assert.equal(
    createCustomizeSearchAdapter({}, () => true),
    undefined,
  );
  assert.equal(
    validCustomizeSearchResult({
      items: [
        { ...hit(1), target: { type: "external", url: "javascript:alert(1)" } },
      ],
      total: 1,
    }),
    false,
  );
  const adapter = createCustomizeSearchAdapter(
    { customizeSearch: async () => ({ items: [], total: -1 }) },
    () => true,
  )!;
  await assert.rejects(
    adapter.search({ query: "ab", page: "skills", section: "more" }),
    /Invalid Customize/,
  );
});
