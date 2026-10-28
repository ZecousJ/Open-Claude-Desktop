import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Settings } from "../../shared/types";
import {
  mcpConfigName,
  mcpConfigText,
  parseMcpConfig,
} from "./mcp-config-file";

const receiptName = "native-extension-mirror-receipt.json";
const hashPattern = /^[a-f0-9]{64}$/;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
function read(file: string) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
    throw Error("The MCP configuration mirror is unavailable.");
  return fs.readFileSync(file, "utf8");
}
function atomic(file: string, contents: string) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
export function clearNativeExtensionMirrorReceipt(root: string) {
  fs.rmSync(path.join(root, receiptName), { force: true });
}

/** A receipt contains hashes only. A failed primary write cannot claim a commit. */
export function prepareNativeExtensionMirror(
  root: string,
  current: Record<string, unknown>,
  next: Record<string, unknown>,
) {
  recoverNativeExtensionMirror(root, current);
  let previous: string | null = null;
  try {
    previous = digest(parseMcpConfig(read(path.join(root, mcpConfigName))));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  atomic(
    path.join(root, receiptName),
    JSON.stringify({ version: 1, desired: digest(next), previous }),
  );
}

/** Before importing an editor mirror, recover only a proven stale secondary.
 * A different external edit remains intentional and is never overwritten. */
export function recoverNativeExtensionMirror(
  root: string,
  current: Record<string, unknown>,
) {
  let receipt: { version?: unknown; desired?: unknown; previous?: unknown };
  try {
    receipt = JSON.parse(read(path.join(root, receiptName)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (
    receipt.version !== 1 ||
    typeof receipt.desired !== "string" ||
    !hashPattern.test(receipt.desired) ||
    !(
      receipt.previous === null ||
      (typeof receipt.previous === "string" &&
        hashPattern.test(receipt.previous))
    )
  )
    throw Error("The MCP configuration mirror receipt is invalid.");
  if (receipt.desired !== digest(current)) {
    clearNativeExtensionMirrorReceipt(root);
    return;
  }
  const file = path.join(root, mcpConfigName);
  let existing: string | null = null;
  try {
    existing = digest(parseMcpConfig(read(file)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing !== receipt.desired && existing === receipt.previous)
    atomic(file, mcpConfigText(current));
  clearNativeExtensionMirrorReceipt(root);
}

/** Settings is the single commit point; history is not part of an MCP edit. */
export function commitNativeMcpServers(
  store: {
    root: string;
    settings: Settings;
    write(name: string, value: unknown): void;
  },
  servers: Record<string, unknown>,
) {
  const next = { ...store.settings, mcpServers: servers };
  prepareNativeExtensionMirror(store.root, store.settings.mcpServers, servers);
  try {
    store.write("settings.json", next);
  } catch (error) {
    try {
      clearNativeExtensionMirrorReceipt(store.root);
    } catch {
      /* No committed target matches this receipt. */
    }
    throw error;
  }
  store.settings = next;
}
