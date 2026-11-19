import test from "node:test";
import assert from "node:assert/strict";
import {
  createDraftBrowser,
  ownsDraftBrowser,
  draftBrowserIds,
  forgetDraftBrowser,
  resetDraftBrowsers,
} from "../electron/browser/draft-sessions";
test("ephemeral browser ownership requires both the account store and invoking window", () => {
  const store = {} as never,
    otherStore = {} as never,
    window = {} as never,
    otherWindow = {} as never;
  const id = createDraftBrowser(store, window, "/authorized");
  assert.equal(ownsDraftBrowser(store, id, window), true);
  assert.equal(ownsDraftBrowser(store, id, otherWindow), false);
  assert.equal(ownsDraftBrowser(otherStore, id, window), false);
  assert.equal(ownsDraftBrowser(store, id, undefined), false);
  assert.deepEqual(draftBrowserIds(store), [id]);
  forgetDraftBrowser(store, id);
  assert.equal(ownsDraftBrowser(store, id, window), false);
  const next = createDraftBrowser(store, window, "/authorized");
  resetDraftBrowsers(store);
  assert.equal(ownsDraftBrowser(store, next, window), false);
  assert.deepEqual(draftBrowserIds(store), []);
});
