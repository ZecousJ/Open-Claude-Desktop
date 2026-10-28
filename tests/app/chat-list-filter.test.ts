import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { parseChatFilter } from "../../src/sidebar/chat-list-filter";
import { defaultFilter } from "../../src/sidebar/listFilter";

test("a damaged or unknown Chat list choice falls back to the defaults, field by field", () => {
  assert.deepEqual(parseChatFilter(null), defaultFilter);
  assert.deepEqual(parseChatFilter("{nope"), defaultFilter);
  const parsed = parseChatFilter(
    JSON.stringify({ type: "cowork", sort: "sideways", groupBy: "date" }),
  );
  assert.equal(parsed.type, "cowork");
  assert.equal(parsed.sort, "activity");
  assert.equal(parsed.groupBy, "date");
  assert.equal(parsed.status, "active");
});

test("the Chat list's filter is kept per account across starts", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const store = new Map<string, string>();
  Object.assign(window, {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    },
  });
  const globals: Record<string, unknown> = {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(
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
  const { useChatListFilter } =
    await import("../../src/sidebar/chat-list-filter");
  const { createRoot } = await import("react-dom/client");
  let current: ReturnType<typeof useChatListFilter>;
  function Harness({ account }: { account: string }) {
    current = useChatListFilter(account);
    return null;
  }
  const mount = async (account: string) => {
    const root = createRoot(document.querySelector("main")!);
    await act(async () => root.render(createElement(Harness, { account })));
    return root;
  };
  try {
    let root = await mount("a1");
    assert.deepEqual(current![0], defaultFilter);
    await act(async () =>
      current![1]((filter) => ({ ...filter, type: "cowork", sort: "name" })),
    );
    await act(async () => root.unmount());

    root = await mount("a1");
    assert.equal(current![0].type, "cowork");
    assert.equal(current![0].sort, "name");
    await act(async () =>
      root.render(createElement(Harness, { account: "a2" })),
    );
    assert.deepEqual(current![0], defaultFilter, "another account's own");
    await act(async () => current![1](defaultFilter));
    await act(async () =>
      root.render(createElement(Harness, { account: "a1" })),
    );
    assert.equal(current![0].type, "cowork");
    await act(async () => root.unmount());
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
