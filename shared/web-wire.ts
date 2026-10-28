import type { Json } from "./web-protocol";

// ---------------------------------------------------------------------------
// Bytes inside JSON: Uint8Array ⇄ {"$bytes": base64}

const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const lookup = new Map([...alphabet].map((c, i) => [c, i]));

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += alphabet[a >> 2];
    out += alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : alphabet[c & 63];
  }
  return out;
}

export function base64ToBytes(text: string): Uint8Array {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text))
    fail("invalid base64");
  const pad = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const n =
      (lookup.get(text[i]!)! << 18) |
      (lookup.get(text[i + 1]!)! << 12) |
      ((lookup.get(text[i + 2]!) ?? 0) << 6) |
      (lookup.get(text[i + 3]!) ?? 0);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/**
 * Sets an own property, so a "__proto__" key from JSON.parse stays data
 * instead of replacing the new object's prototype.
 */
function put(out: Json, key: string, value: unknown) {
  if (key === "__proto__")
    Object.defineProperty(out, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  else out[key] = value;
}

/** The JSON form of a value, with every Uint8Array as {"$bytes": base64}. */
export function encodeWireValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: bytesToBase64(value) };
  if (Array.isArray(value)) return value.map(encodeWireValue);
  if (value && typeof value === "object") {
    const out: Json = {};
    for (const [key, item] of Object.entries(value))
      if (item !== undefined) put(out, key, encodeWireValue(item));
    return out;
  }
  return value;
}

/** Reverses encodeWireValue. */
export function decodeWireValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeWireValue);
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (
      entries.length === 1 &&
      entries[0]![0] === "$bytes" &&
      typeof entries[0]![1] === "string"
    )
      return base64ToBytes(entries[0]![1]);
    const out: Json = {};
    for (const [key, item] of entries) put(out, key, decodeWireValue(item));
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Small validation helpers

export class WebProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebProtocolError";
  }
}

export function fail(message: string): never {
  throw new WebProtocolError(message);
}
