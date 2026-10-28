import assert from "node:assert/strict";
import test from "node:test";
import {
  forgetAccountLocalData,
  onForgetAccountData,
} from "../../src/app/forget-account-data";

function fakeStorage(initial: Record<string, string>) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    storage: {
      get length() {
        return map.size;
      },
      key: (index: number) => [...map.keys()][index] ?? null,
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    } as unknown as Storage,
  };
}

test("signing out forgets the account's choices kept on the device, not the language or theme", () => {
  const { map, storage } = fakeStorage({
    "claudex.code.repositories": "[]",
    "claudex.modelLabels": "{}",
    startCardDismissals: "[]",
    "claudex.sessionRail.shown": "0",
    "claudex.sessionRail.folds": "{}",
    "claudex.locale": "ja-JP",
    "claudex.boot": '{"theme":"dark"}',
  });
  let cleared = 0;
  onForgetAccountData(() => cleared++);
  forgetAccountLocalData(storage);
  assert.deepEqual([...map.keys()].sort(), ["claudex.boot", "claudex.locale"]);
  assert.ok(cleared >= 1, "stores clear their memory");
});
