import assert from "node:assert/strict";
import test from "node:test";
import {
  applyUpdate,
  validateState,
} from "../../src/mobile-conversation/state";
import type { ConversationRenderState } from "../../shared/mobile/conversation-contract";
const state = {
  version: 1,
  sessionId: "synthetic",
  revision: 1,
  theme: "light",
  conversation: { id: "synthetic", mode: "chat", turns: [] },
} as unknown as ConversationRenderState;
test("old native states remain valid without a locale", () => {
  assert.doesNotThrow(() => validateState(state));
});
test("explicit locale updates and omission preserves it", () => {
  const localized = applyUpdate(state, {
    version: 1,
    sessionId: state.sessionId,
    baseRevision: 1,
    revision: 2,
    changes: [],
    locale: "zh-CN",
  });
  assert.equal(localized.locale, "zh-CN");
  const next = applyUpdate(localized, {
    version: 1,
    sessionId: state.sessionId,
    baseRevision: 2,
    revision: 3,
    changes: [],
  });
  assert.equal(next.locale, "zh-CN");
});
test("malformed locale fails before admission", () => {
  for (const locale of [7, null, "x".repeat(65)])
    assert.throws(() => validateState({ ...state, locale }), /Invalid locale/);
});
