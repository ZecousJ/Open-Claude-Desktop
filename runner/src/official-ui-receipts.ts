/** Durable replay guard for experimental official Web mutations. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  officialUiReadMaxBytes,
  type OfficialUiReadResponse,
} from "../../shared/official-ui-web";

type Receipt =
  | { hash: string; phase: "pending" }
  | {
      hash: string;
      phase: "done";
      status: number;
      contentType: string;
      body: string;
    };
export type Reservation =
  | { kind: "reserved"; file: string }
  | { kind: "pending" }
  | { kind: "conflict" }
  | { kind: "done"; answer: OfficialUiReadResponse };

export function syncOfficialStateDirectory(dir: string) {
  // Windows does not provide a portable directory handle through Node.
  if (process.platform === "win32")
    throw Error("Durable action reservations are unavailable on Windows.");
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function officialActionReceiptFile(root: string, key: string) {
  return path.join(
    root,
    "official-ui-action-receipts",
    `${createHash("sha256").update(key).digest("hex")}.json`,
  );
}

export function readOfficialAction(root: string, key: string, hash?: string) {
  const file = officialActionReceiptFile(root, key);
  const directory = fs.lstatSync(path.dirname(file), { throwIfNoEntry: false });
  if (!directory) return undefined;
  if (!directory.isDirectory())
    throw Error("The action receipt directory is not available.");
  return readExisting(file, hash);
}

export function reserveOfficialAction(
  root: string,
  key: string,
  hash: string,
): Reservation {
  const dir = path.join(root, "official-ui-action-receipts");
  if (
    typeof key !== "string" ||
    !key ||
    typeof hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(hash)
  )
    throw Error("Invalid action receipt identity.");
  if (process.platform !== "win32")
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink())
    throw Error("The action receipt directory is not available.");
  const file = officialActionReceiptFile(root, key);
  // Reading an existing outcome must not depend on write/flush availability.
  const existing = readExisting(file, hash);
  if (existing) return existing;
  if (process.platform === "win32")
    throw Error("Durable action reservations are unavailable on Windows.");
  // Directory existence is not proof that its parent entry has been flushed.
  syncOfficialStateDirectory(root);
  try {
    const fd = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeFileSync(
        fd,
        JSON.stringify({ hash, phase: "pending" } satisfies Receipt),
      );
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    syncOfficialStateDirectory(dir);
    return { kind: "reserved", file };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const raced = readExisting(file, hash);
  if (!raced) throw Error("The action receipt changed during reservation.");
  return raced;
}

function readExisting(
  file: string,
  hash?: string,
): Exclude<Reservation, { kind: "reserved" }> | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > officialUiReadMaxBytes * 2
  )
    throw Error("The action receipt is not valid.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let text: string;
  try {
    const before = fs.fstatSync(fd);
    if (
      !before.isFile() ||
      before.dev !== stat.dev ||
      before.ino !== stat.ino ||
      before.size !== stat.size ||
      before.size > officialUiReadMaxBytes * 2
    )
      throw Error("The action receipt changed during read.");
    // Preserve the existing JSON capacity (base64 body plus envelope), but
    // never let a file growing after stat control an unbounded allocation.
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(
        fd,
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (!count) break;
      length += count;
    }
    const after = fs.fstatSync(fd),
      latest = fs.lstatSync(file);
    if (
      length !== before.size ||
      !after.isFile() ||
      after.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      !latest.isFile() ||
      latest.isSymbolicLink() ||
      latest.dev !== before.dev ||
      latest.ino !== before.ino ||
      latest.size !== before.size ||
      latest.mtimeMs !== before.mtimeMs ||
      latest.ctimeMs !== before.ctimeMs
    )
      throw Error("The action receipt changed during read.");
    text = bytes.subarray(0, length).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
  const saved = JSON.parse(text) as Receipt;
  if (
    !saved ||
    typeof saved !== "object" ||
    Array.isArray(saved) ||
    typeof saved.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(saved.hash)
  )
    throw Error("The action receipt is not valid.");
  if (hash !== undefined && saved.hash !== hash) return { kind: "conflict" };
  if (saved.phase === "pending") return { kind: "pending" };
  if (
    saved.phase !== "done" ||
    !Number.isInteger(saved.status) ||
    saved.status < 200 ||
    saved.status > 599 ||
    typeof saved.contentType !== "string" ||
    typeof saved.body !== "string" ||
    saved.body.length % 4 !== 0 ||
    saved.body.length > Math.ceil(officialUiReadMaxBytes / 3) * 4
  )
    throw Error("The action receipt is not valid.");
  const body = Buffer.from(saved.body, "base64");
  if (body.byteLength > officialUiReadMaxBytes)
    throw Error("The action receipt is too large.");
  // A repeated-group regex over a valid multi-MiB body can exhaust the JS
  // stack. Bounded decoding plus exact round-trip validates canonical base64.
  if (body.toString("base64") !== saved.body)
    throw Error("The action receipt is not valid.");
  return {
    kind: "done",
    answer: { status: saved.status, contentType: saved.contentType, body },
  };
}

export function finishOfficialAction(
  file: string,
  hash: string,
  answer: OfficialUiReadResponse,
) {
  const data: Receipt = {
    hash,
    phase: "done",
    status: answer.status,
    contentType: answer.contentType,
    body: Buffer.from(answer.body).toString("base64"),
  };
  writeOfficialStateFile(file, data);
}

export function writeOfficialStateFile(file: string, data: unknown) {
  if (process.platform === "win32")
    throw Error("Durable action reservations are unavailable on Windows.");
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(data));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
    syncOfficialStateDirectory(path.dirname(file));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
