import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const source = fs.readFileSync(
  new URL("../electron/official-ui/page-shim.cjs", import.meta.url),
  "utf8",
);
function fixture() {
  const writes: any[] = [],
    texts: any[] = [],
    fetches: string[] = [];
  let response: any = {
      ok: true,
      text: async () => "https://shares.example.test/s/token",
    },
    failure = false;
  class Item {
    types: string[];
    presentationStyle: string;
    data: any;
    constructor(data: any, options: any = {}) {
      this.data = data;
      this.types = Object.keys(data);
      this.presentationStyle = options.presentationStyle ?? "unspecified";
    }
    async getType(type: string) {
      return this.data[type];
    }
  }
  const clipboard: any = {
    write: (items: any) => {
      writes.push(items);
      return Promise.all(
        items.map((i: any) =>
          Promise.all(i.types.map((t: string) => i.getType(t))),
        ),
      ).then(() => undefined);
    },
    writeText: async (text: string) => {
      texts.push(text);
    },
  };
  const window: any = {};
  const context: any = {
    navigator: { clipboard },
    window,
    location: { origin: "http://localhost:1234" },
    URL,
    Blob,
    ClipboardItem: Item,
    fetch: async (url: string) => {
      fetches.push(url);
      if (failure) throw Error("network");
      return response;
    },
    require: () => ({
      contextBridge: { executeInMainWorld: ({ func }: any) => func() },
    }),
  };
  vm.runInNewContext(
    source.slice(
      0,
      source.indexOf(
        "\ncontextBridge.executeInMainWorld({",
        source.indexOf("contextBridge.executeInMainWorld({") + 1,
      ),
    ),
    context,
  );
  return {
    clipboard,
    Item,
    writes,
    texts,
    fetches,
    window,
    set: (v: any) => {
      if (v.response) response = v.response;
      if (v.failure) failure = true;
    },
  };
}
test("original promised text/plain shape invokes native synchronously and maps exact hosted URL", async () => {
  const f = fixture();
  let resolve: any;
  const data = new Promise((r) => (resolve = r));
  const promise = f.clipboard.write([new f.Item({ "text/plain": data })]);
  assert.equal(f.writes.length, 1);
  assert.equal(f.fetches.length, 0);
  resolve(
    new Blob(["http://localhost:1234/share/snapshot"], { type: "text/plain" }),
  );
  await promise;
  assert.equal(
    await (await f.writes[0][0].getType("text/plain")).text(),
    "https://shares.example.test/s/token",
  );
  assert.deepEqual(f.fetches, ["/api/__claudex/share-url/snapshot"]);
});
test("writeText resolves share too and development loopback hosted URL remains supported", async () => {
  const f = fixture();
  f.set({
    response: { ok: true, text: async () => "http://localhost:5678/s/token" },
  });
  await f.clipboard.writeText("http://localhost:1234/share/snapshot");
  assert.deepEqual(f.texts, ["http://localhost:5678/s/token"]);
});
test("nonmatching plain text preserves original blob, larger and rich/multiple payloads are untouched", async () => {
  const f = fixture();
  const blob = new Blob(["ordinary text"]);
  await f.clipboard.write([new f.Item({ "text/plain": blob })]);
  assert.equal(await f.writes[0][0].getType("text/plain"), blob);
  const big = new Blob(["x".repeat(8193)]);
  await f.clipboard.write([new f.Item({ "text/plain": big })]);
  assert.equal(await f.writes[1][0].getType("text/plain"), big);
  const rich = [
    new f.Item({ "text/plain": blob, "text/html": new Blob(["<b>text</b>"]) }),
  ];
  await f.clipboard.write(rich);
  assert.equal(f.writes[2], rich);
  const multiple = [
    new f.Item({ "text/plain": blob }),
    new f.Item({ "text/plain": blob }),
  ];
  await f.clipboard.write(multiple);
  assert.equal(f.writes[3], multiple);
  assert.deepEqual(f.fetches, []);
});
test("resolver failure and invalid returned URL reject without fallback loopback copy", async () => {
  for (const raw of [
    "javascript:alert(1)",
    "https://user:secret@example.test/s/t",
    "http://localhost:1234/share/snapshot",
    "https://example.test/\nsecret",
    "",
  ]) {
    const f = fixture();
    f.set({ response: { ok: true, text: async () => raw } });
    await assert.rejects(
      f.clipboard.writeText("http://localhost:1234/share/snapshot"),
    );
    assert.deepEqual(f.texts, []);
    await assert.rejects(
      f.clipboard.write([
        new f.Item({
          "text/plain": new Blob(["http://localhost:1234/share/snapshot"]),
        }),
      ]),
    );
  }
  for (const mode of ["network", "status"]) {
    const f = fixture();
    f.set(mode === "network" ? { failure: true } : { response: { ok: false } });
    await assert.rejects(
      f.clipboard.writeText("http://localhost:1234/share/snapshot"),
    );
    assert.deepEqual(f.texts, []);
  }
});
test("foreign origin or partial/query/hash share paths never trigger mapping", async () => {
  const f = fixture();
  for (const text of [
    "https://example.test/share/snapshot",
    "http://localhost:1234.evil.test/share/snapshot",
    "http://localhost:1234/share/snapshot/extra",
    "http://localhost:1234/share/snapshot?x=1",
    "http://localhost:1234/share/snapshot#x",
  ])
    await f.clipboard.writeText(text);
  assert.equal(f.fetches.length, 0);
  assert.equal(f.texts.length, 5);
});
