import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ImportedStorage = Map<string, { key: string; value: string }[]>;
const maxBytes = 64 * 1024 * 1024;
const blockBytes = 32768;

// Read-only snapshot, manifest, WAL and SSTable decoding.
class Reader {
  private offset = 0;
  constructor(private data: Buffer) {}
  done() {
    return this.offset >= this.data.length;
  }
  take(length: number) {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      this.offset + length > this.data.length
    )
      throw new Error("Invalid storage record");
    const value = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  byte() {
    return this.take(1)[0];
  }
  varint() {
    let value = 0n;
    for (let shift = 0n; shift < 64n; shift += 7n) {
      const byte = this.byte();
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    throw new Error("Invalid storage integer");
  }
  bytes() {
    return this.take(Number(this.varint()));
  }
  fixed32() {
    return this.take(4).readUInt32LE();
  }
  fixed64() {
    return this.take(8).readBigUInt64LE();
  }
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0x82f63b78 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function storageChecksum(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;
  return ((((crc >>> 15) | (crc << 17)) >>> 0) + 0xa282ead8) >>> 0;
}

function readLog(
  data: Buffer,
  receive: (record: Buffer) => void,
  strict = false,
) {
  let offset = 0;
  let fragments: Buffer[] = [];
  while (offset + 7 <= data.length) {
    const remaining = blockBytes - (offset % blockBytes);
    if (remaining < 7) {
      offset += remaining;
      continue;
    }
    const checksum = data.readUInt32LE(offset);
    const length = data.readUInt16LE(offset + 4);
    const kind = data[offset + 6];
    const start = offset + 7;
    if (start + length > data.length || length + 7 > remaining) {
      if (strict) throw new Error("Truncated storage manifest");
      return;
    }
    const payload = data.subarray(start, start + length);
    offset = start + length;
    if (!kind) continue;
    if (checksum !== storageChecksum(data.subarray(start - 1, offset))) {
      if (strict) throw new Error("Invalid storage manifest checksum");
      return;
    }
    if (kind === 1) receive(payload);
    else if (kind === 2) fragments = [payload];
    else if (kind === 3) fragments.push(payload);
    else if (kind === 4) {
      fragments.push(payload);
      receive(Buffer.concat(fragments));
      fragments = [];
    } else throw new Error("Invalid storage log record");
  }
  if (
    strict &&
    (fragments.length ||
      (offset < data.length && blockBytes - (offset % blockBytes) >= 7))
  )
    throw new Error("Truncated storage manifest");
}

function decompress(data: Buffer) {
  const reader = new Reader(data);
  const length = Number(reader.varint());
  if (length > maxBytes) throw new Error("Storage block too large");
  const output = Buffer.alloc(length);
  let offset = 0;
  while (!reader.done()) {
    const tag = reader.byte();
    let count: number;
    let distance = 0;
    switch (tag & 3) {
      case 0:
        count = (tag >>> 2) + 1;
        if (count > 60) {
          const bytes = count - 60;
          count = 0;
          for (let index = 0; index < bytes; index++)
            count += reader.byte() * 2 ** (8 * index);
          count++;
        }
        if (offset + count > output.length)
          throw new Error("Invalid storage literal");
        reader.take(count).copy(output, offset);
        offset += count;
        continue;
      case 1:
        count = 4 + ((tag >>> 2) & 7);
        distance = ((tag >>> 5) << 8) | reader.byte();
        break;
      case 2:
        count = (tag >>> 2) + 1;
        distance = reader.byte() | (reader.byte() << 8);
        break;
      default:
        count = (tag >>> 2) + 1;
        distance = reader.fixed32();
    }
    if (!distance || distance > offset || offset + count > output.length)
      throw new Error("Invalid storage copy");
    for (let index = 0; index < count; index++, offset++)
      output[offset] = output[offset - distance];
  }
  if (offset !== output.length) throw new Error("Invalid storage block length");
  return output;
}

function readBlock(data: Buffer, offset: number, length: number) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length + 5 > data.length
  )
    throw new Error("Invalid storage block handle");
  if (
    data.readUInt32LE(offset + length + 1) !==
    storageChecksum(data.subarray(offset, offset + length + 1))
  )
    throw new Error("Invalid storage block checksum");
  const content = data.subarray(offset, offset + length);
  if (data[offset + length] === 0) return content;
  if (data[offset + length] === 1) return decompress(content);
  throw new Error("Unsupported storage compression");
}

function* entries(block: Buffer) {
  if (block.length < 4) throw new Error("Invalid storage block");
  const end = block.length - 4 - block.readUInt32LE(block.length - 4) * 4;
  if (end < 0) throw new Error("Invalid storage restart table");
  const reader = new Reader(block.subarray(0, end));
  let previous = Buffer.alloc(0);
  while (!reader.done()) {
    const shared = Number(reader.varint());
    const length = Number(reader.varint());
    const valueLength = Number(reader.varint());
    if (shared > previous.length) throw new Error("Invalid storage key prefix");
    const key = Buffer.concat([
      previous.subarray(0, shared),
      reader.take(length),
    ]);
    const value = reader.take(valueLength);
    previous = key;
    yield { key, value };
  }
}

function storageKey(key: Buffer) {
  if (key[0] !== 95) return;
  const end = key.indexOf(0, 1);
  if (end < 0) return;
  const origin = key.subarray(1, end).toString("latin1");
  if (origin.includes("^") || !/^https?:\/\//.test(origin)) return;
  try {
    const url = new URL(origin);
    if (url.origin === origin && url.pathname === "/")
      return { origin, host: url.hostname, key: key.subarray(end + 1) };
  } catch {}
}

function storageText(data: Buffer) {
  if (data[0] === 1) return data.subarray(1).toString("latin1");
  if (data[0] === 0 && (data.length - 1) % 2 === 0)
    return data.subarray(1).toString("utf16le");
}

export async function readStorageSnapshot(
  directory: string,
  allowed: (host: string) => boolean,
): Promise<ImportedStorage> {
  const current = (
    await fs.readFile(path.join(directory, "CURRENT"), "latin1")
  ).trim();
  if (!/^MANIFEST-\d+$/.test(current))
    throw new Error("Invalid storage manifest name");
  const tables = new Set<bigint>();
  let log = 0n;
  let previousLog = 0n;
  readLog(
    await fs.readFile(path.join(directory, current)),
    (record) => {
      const reader = new Reader(record);
      while (!reader.done()) {
        switch (Number(reader.varint())) {
          case 1:
            reader.bytes();
            break;
          case 2:
            log = reader.varint();
            break;
          case 3:
          case 4:
            reader.varint();
            break;
          case 5:
            reader.varint();
            reader.bytes();
            break;
          case 6:
            reader.varint();
            tables.delete(reader.varint());
            break;
          case 7:
            reader.varint();
            tables.add(reader.varint());
            reader.varint();
            reader.bytes();
            reader.bytes();
            break;
          case 9:
            previousLog = reader.varint();
            break;
          default:
            throw new Error("Unsupported storage manifest tag");
        }
      }
    },
    true,
  );
  const files = await fs.readdir(directory);
  const latest = new Map<string, { sequence: bigint; value: Buffer | null }>();
  const receive = (key: Buffer, sequence: bigint, value: Buffer | null) => {
    const parsed = storageKey(key);
    if (!parsed || !allowed(parsed.host)) return;
    const encoded = key.toString("latin1");
    const previous = latest.get(encoded);
    if (!previous || previous.sequence < sequence)
      latest.set(encoded, { sequence, value });
    if (latest.size > 100_000) throw new Error("Too many storage entries");
  };
  for (const table of tables) {
    const stem = String(table).padStart(6, "0");
    const name = files.find(
      (file) => file === `${stem}.ldb` || file === `${stem}.sst`,
    );
    if (!name) throw new Error("Storage table missing");
    const data = await fs.readFile(path.join(directory, name));
    if (
      data.length < 48 ||
      data.readUInt32LE(data.length - 8) !== 0x8b80fb57 ||
      data.readUInt32LE(data.length - 4) !== 0xdb477524
    )
      throw new Error("Invalid storage table footer");
    const footer = new Reader(data.subarray(data.length - 48));
    footer.varint();
    footer.varint();
    const index = readBlock(
      data,
      Number(footer.varint()),
      Number(footer.varint()),
    );
    for (const { value } of entries(index)) {
      const handle = new Reader(value);
      const block = readBlock(
        data,
        Number(handle.varint()),
        Number(handle.varint()),
      );
      for (const { key, value } of entries(block)) {
        if (key.length < 8) throw new Error("Invalid internal storage key");
        const tag = key.readBigUInt64LE(key.length - 8);
        receive(
          key.subarray(0, key.length - 8),
          tag >> 8n,
          (tag & 255n) === 1n ? value : null,
        );
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  const logs = files
    .filter((file) => /^\d+\.log$/.test(file))
    .map((name) => ({ name, number: BigInt(name.slice(0, -4)) }))
    .filter(
      ({ number }) =>
        number >= log || (previousLog !== 0n && number >= previousLog),
    )
    .sort((first, second) => (first.number < second.number ? -1 : 1));
  for (const { name } of logs)
    readLog(await fs.readFile(path.join(directory, name)), (record) => {
      const reader = new Reader(record);
      const sequence = reader.fixed64();
      const count = reader.fixed32();
      for (let index = 0; index < count; index++) {
        const kind = reader.byte();
        if (kind !== 0 && kind !== 1)
          throw new Error("Invalid storage batch entry");
        const key = reader.bytes();
        receive(
          key,
          sequence + BigInt(index),
          kind === 1 ? reader.bytes() : null,
        );
      }
    });
  const storage: ImportedStorage = new Map();
  for (const [encoded, { value }] of latest) {
    if (value === null) continue;
    const parsed = storageKey(Buffer.from(encoded, "latin1"));
    const key = parsed && storageText(parsed.key);
    const text = storageText(value);
    if (!parsed || key === undefined || text === undefined) continue;
    const items = storage.get(parsed.origin) ?? [];
    items.push({ key, value: text });
    storage.set(parsed.origin, items);
  }
  return storage;
}

export async function readChromeStorage(
  file: string,
  allowed: (host: string) => boolean,
): Promise<ImportedStorage> {
  const parent = path.dirname(file);
  const profile =
    path.basename(parent) === "Network" ? path.dirname(parent) : parent;
  const directory = path.join(profile, "Local Storage", "leveldb");
  const files = await fs.readdir(directory).catch(() => []);
  if (!files.length) return new Map();
  const snapshot = await fs.mkdtemp(
    path.join(os.tmpdir(), "claudex-import-storage-"),
  );
  try {
    await fs.chmod(snapshot, 0o700);
    let bytes = 0;
    for (const file of files) {
      if (file === "LOCK" || file.startsWith("LOG")) continue;
      const source = path.join(directory, file);
      const stat = await fs.lstat(source).catch(() => undefined);
      if (!stat?.isFile()) continue;
      bytes += stat.size;
      if (bytes > maxBytes) throw new Error("Storage snapshot too large");
      await fs.copyFile(source, path.join(snapshot, file));
      await fs.chmod(path.join(snapshot, file), 0o600);
    }
    return await readStorageSnapshot(snapshot, allowed);
  } finally {
    await fs.rm(snapshot, { recursive: true, force: true });
  }
}
