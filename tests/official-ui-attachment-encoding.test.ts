import test from "node:test";
import assert from "node:assert/strict";
import { storeCodeAttachments } from "../electron/official-ui/native/code-attachments";

test("native transport accepts exactly 64 MiB but delegates per-file policy to the host", async () => {
  const sizes = [22, 21, 21].map((n) => n * 1024 * 1024);
  const files = sizes.map((size, i) => ({
    name: `${i}.txt`,
    base64: Buffer.alloc(size).toString("base64"),
  }));
  let calls = 0;
  await storeCodeAttachments(
    async (_name, payload) => {
      calls++;
      assert.deepEqual(
        (payload as Array<{ data: Uint8Array }>).map((f) => f.data.length),
        sizes,
      );
      return [];
    },
    [],
    files,
  );
  assert.equal(calls, 1);
});

test("an overlong encoded file is rejected without calling storage", async () => {
  let calls = 0;
  await assert.rejects(
    storeCodeAttachments(
      async () => {
        calls++;
        return [];
      },
      [],
      [{ name: "too-large.txt", base64: "A".repeat(43_000_004) }],
    ),
  );
  assert.equal(calls, 0);
});

test("multi-megabyte native attachment validation is stack safe and preserves bytes", async () => {
  const bytes = Buffer.alloc(8 * 1024 * 1024, 251);
  let calls = 0;
  await storeCodeAttachments(
    async (name, payload) => {
      calls++;
      assert.equal(name, "officialStoreCodeAttachments");
      const files = payload as Array<{ name: string; data: Uint8Array }>;
      assert.equal(files[0].name, "large.txt");
      assert.deepEqual(Buffer.from(files[0].data), bytes);
      return [];
    },
    [],
    [{ name: "large.txt", base64: bytes.toString("base64") }],
  );
  assert.equal(calls, 1);
});

test("canonical base64 accepts every byte and rejects malformed padding before storage", async () => {
  let calls = 0;
  const call = async () => {
    calls++;
    return [];
  };
  for (let value = 0; value < 256; value++) {
    for (const length of [1, 2, 3]) {
      await storeCodeAttachments(
        call,
        [],
        [
          {
            name: "valid.txt",
            base64: Buffer.alloc(length, value).toString("base64"),
          },
        ],
      );
    }
  }
  assert.equal(calls, 768);
  for (const base64 of [
    "A",
    "AAA",
    "A===",
    "====",
    "=AAA",
    "AA=A",
    "AA==AAAA",
    "AA\n=",
    "AA-_",
    "AB==",
    "AAB=",
    "YWJj\n",
  ]) {
    await assert.rejects(
      storeCodeAttachments(call, [], [{ name: "bad.txt", base64 }]),
      /Invalid attachment encoding/,
    );
  }
  assert.equal(calls, 768);
});

test("oversized batches are rejected before decoding or invoking storage", async () => {
  const base64 = Buffer.alloc(22 * 1024 * 1024).toString("base64");
  let calls = 0;
  // Spy only after constructing the encoded input; no decoded allocations are
  // allowed for a batch that already exceeds its host transport budget.
  const original = Buffer.from;
  let decoded = 0;
  Buffer.from = ((...args: Parameters<typeof Buffer.from>) => {
    if ((args as unknown[])[1] === "base64") decoded++;
    return Reflect.apply(original, Buffer, args);
  }) as typeof Buffer.from;
  try {
    await assert.rejects(
      storeCodeAttachments(
        async () => {
          calls++;
          return [];
        },
        [],
        Array.from({ length: 3 }, (_, i) => ({ name: `${i}.txt`, base64 })),
      ),
      /Combined attachments exceed 64 MB/,
    );
    assert.equal(calls, 0);
    assert.equal(decoded, 0);
  } finally {
    Buffer.from = original;
  }
});
