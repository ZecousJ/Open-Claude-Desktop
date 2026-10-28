import assert from "node:assert/strict";
import test from "node:test";
import {
  historySearchInput,
  historySearchResult,
} from "../../shared/history-search";
test("stored history search accepts Unicode and bounded options", () => {
  assert.deepEqual(historySearchInput.parse({ query: "  旅行  " }), {
    query: "旅行",
    includeArchived: false,
    limit: 20,
  });
  assert.equal(
    historySearchInput.parse({
      query: "😀".repeat(200),
      includeArchived: true,
      limit: 50,
    }).query.length,
    400,
  );
  assert.throws(() => historySearchInput.parse({ query: "😀".repeat(201) }));
  assert.throws(() => historySearchInput.parse({ query: "x", limit: 51 }));
  assert.throws(() => historySearchInput.parse({ query: "x", userId: 7 }));
  assert.equal(
    historySearchInput.parse({ query: "x", projectId: "project" }).projectId,
    "project",
  );
  assert.throws(() => historySearchInput.parse({ query: "x", projectId: "" }));
});
test("stored search response preserves snippets without requiring loaded turns", () => {
  const response = {
    results: [
      {
        conversationId: "history-only",
        title: "title",
        mode: "chat",
        archived: false,
        updatedAt: 123,
        turnId: "turn",
        snippet: "旅行",
      },
    ],
  };
  assert.deepEqual(historySearchResult.parse(response), response);
  assert.throws(() =>
    historySearchResult.parse({
      results: [{ ...response.results[0], mode: "desktop" }],
    }),
  );
});
