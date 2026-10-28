import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readChromeStorage,
  readStorageSnapshot,
  storageChecksum,
} from "../../electron/browser/chrome-import-storage";

function varint(value: number) {
  const bytes: number[] = [];
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
}

function bytes(value: Buffer) {
  return Buffer.concat([varint(value.length), value]);
}
function text(value: string, unicode = false) {
  return Buffer.concat([
    Buffer.from([unicode ? 0 : 1]),
    Buffer.from(value, unicode ? "utf16le" : "latin1"),
  ]);
}
function key(origin: string, name: string) {
  return Buffer.concat([Buffer.from(`_${origin}\0`, "latin1"), text(name)]);
}
function logRecord(payload: Buffer) {
  const header = Buffer.alloc(7);
  header.writeUInt32LE(
    storageChecksum(Buffer.concat([Buffer.from([1]), payload])),
  );
  header.writeUInt16LE(payload.length, 4);
  header[6] = 1;
  return Buffer.concat([header, payload]);
}
function batch(sequence: bigint, rows: [Buffer, Buffer | null][]) {
  const header = Buffer.alloc(12);
  header.writeBigUInt64LE(sequence);
  header.writeUInt32LE(rows.length, 8);
  return logRecord(
    Buffer.concat([
      header,
      ...rows.map(([key, value]) =>
        Buffer.concat([
          Buffer.from([value === null ? 0 : 1]),
          bytes(key),
          ...(value === null ? [] : [bytes(value)]),
        ]),
      ),
    ]),
  );
}

function block(rows: { key: Buffer; value: Buffer }[]) {
  const restarts = Buffer.alloc(8);
  restarts.writeUInt32LE(1, 4);
  const payload = Buffer.concat([
    ...rows.map(({ key, value }) =>
      Buffer.concat([
        varint(0),
        varint(key.length),
        varint(value.length),
        key,
        value,
      ]),
    ),
    restarts,
  ]);
  const suffix = Buffer.alloc(5);
  suffix.writeUInt32LE(
    storageChecksum(Buffer.concat([payload, Buffer.from([0])])),
    1,
  );
  return { data: Buffer.concat([payload, suffix]), length: payload.length };
}

test("Chrome local storage snapshots honor WAL sequence, deletion, origin selection and Unicode", async (context) => {
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "claudex-storage-test-"),
  );
  context.after(() => fs.rm(home, { recursive: true, force: true }));
  const profile = path.join(home, "Default");
  const directory = path.join(profile, "Local Storage", "leveldb");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "CURRENT"), "MANIFEST-000001\n");
  await fs.writeFile(
    path.join(directory, "MANIFEST-000001"),
    logRecord(Buffer.from([2, 3])),
  );
  const token = key("https://example.com", "token");
  const deleted = key("https://example.com", "deleted");
  await fs.writeFile(
    path.join(directory, "000002.log"),
    batch(100n, [[token, text("stale-ignored")]]),
  );
  await fs.writeFile(
    path.join(directory, "000003.log"),
    Buffer.concat([
      batch(1n, [
        [token, text("old")],
        [deleted, text("remove")],
      ]),
      batch(3n, [
        [token, text("ログイン", true)],
        [deleted, null],
        [key("https://blocked.example", "secret"), text("must-not-import")],
        [key("https://example.com^partition", "secret"), text("partitioned")],
      ]),
    ]),
  );
  const result = await readChromeStorage(
    path.join(profile, "Network", "Cookies"),
    (host) => host === "example.com",
  );
  assert.deepEqual(
    [...result],
    [["https://example.com", [{ key: "token", value: "ログイン" }]]],
  );
  const original = await fs.readFile(path.join(directory, "000003.log"));
  assert.ok(original.includes(Buffer.from("must-not-import")));
});

test("Chrome local storage reads checksummed SSTables and newer WAL tombstones", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "claudex-storage-table-"),
  );
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const internalKey = (name: string, sequence: bigint) => {
    const tag = Buffer.alloc(8);
    tag.writeBigUInt64LE((sequence << 8n) | 1n);
    return Buffer.concat([key("https://example.com", name), tag]);
  };
  const data = block([
    { key: internalKey("saved", 1n), value: text("from-table") },
    { key: internalKey("deleted", 2n), value: text("must-remove") },
  ]);
  const index = block([
    {
      key: Buffer.from("last"),
      value: Buffer.concat([varint(0), varint(data.length)]),
    },
  ]);
  const footer = Buffer.alloc(48);
  Buffer.concat([
    varint(0),
    varint(0),
    varint(data.data.length),
    varint(index.length),
  ]).copy(footer);
  footer.writeUInt32LE(0x8b80fb57, 40);
  footer.writeUInt32LE(0xdb477524, 44);
  await fs.writeFile(
    path.join(directory, "000004.ldb"),
    Buffer.concat([data.data, index.data, footer]),
  );
  await fs.writeFile(path.join(directory, "CURRENT"), "MANIFEST-000001\n");
  await fs.writeFile(
    path.join(directory, "MANIFEST-000001"),
    logRecord(
      Buffer.concat([
        Buffer.from([2, 5, 7, 0, 4]),
        varint(data.data.length + index.data.length + footer.length),
        bytes(Buffer.alloc(0)),
        bytes(Buffer.alloc(0)),
      ]),
    ),
  );
  await fs.writeFile(
    path.join(directory, "000005.log"),
    batch(3n, [[key("https://example.com", "deleted"), null]]),
  );
  assert.deepEqual(
    [...(await readStorageSnapshot(directory, () => true))],
    [["https://example.com", [{ key: "saved", value: "from-table" }]]],
  );
  const corrupt = await fs.readFile(path.join(directory, "000004.ldb"));
  corrupt[1] ^= 1;
  await fs.writeFile(path.join(directory, "000004.ldb"), corrupt);
  await assert.rejects(
    readStorageSnapshot(directory, () => true),
    /checksum/,
  );
});

test("Chrome local storage rejects corrupt manifests and directory traversal", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "claudex-storage-invalid-"),
  );
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "CURRENT"), "../outside");
  await assert.rejects(
    readStorageSnapshot(directory, () => true),
    /manifest name/,
  );
  await fs.writeFile(path.join(directory, "CURRENT"), "MANIFEST-000001");
  const corrupt = logRecord(Buffer.from([2, 3]));
  corrupt[0] ^= 1;
  await fs.writeFile(path.join(directory, "MANIFEST-000001"), corrupt);
  await assert.rejects(
    readStorageSnapshot(directory, () => true),
    /checksum/,
  );
});
