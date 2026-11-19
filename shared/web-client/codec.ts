/**
 * Arguments on the wire. Bytes travel inside the JSON body as
 * `{"$bytes": base64}` (shared/web-protocol.ts); a Uint8Array larger than
 * `inlineBytes` is uploaded first in 1 MiB chunks and replaced by
 * `{"$upload": id}`, which the runner resolves to the stored bytes (an
 * attachment of several MiB would not fit the 1 MiB RPC body).
 * Large profile photo data URLs use {"$avatarPhoto": {"$upload": id}};
 * the runner restores the string before validating the settings.
 *
 * The upload endpoints (served by Go, W-RELAY; the bytes land in the
 * user's webstore file area, counted against the quota):
 *   POST uploads                        {name, size, type, sha256} → {id}
 *   PUT  uploads/<id>/chunks/<index>    raw bytes (≤ uploadChunkBytes)
 *   POST uploads/<id>/complete          {} → {id}
 */
import {
  rpcRequest,
  webErrorCodes,
  webLimits,
  webPaths,
} from "../web-protocol";
import { apiValue, bridgeError, messages, readJson, apiError } from "./errors";
import { attachmentObjectURL } from "../attachment-object";
import type { WebTransport } from "./transport";

/** Bytes kept inside the body; base64 makes them a third larger. */
export const inlineBytes = 256 * 1024;
/** Largest single upload (the webstore's default per-file limit is 30 MB). */
export const maxUploadBytes = 64 * 1024 * 1024;

export interface UploadRef {
  $upload: string;
}

export interface UploadTransfer {
  signal: AbortSignal;
  onProgress?(loaded: number, total: number): void;
  private?: boolean;
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function putObject(address: string, sha: string, bytes: Uint8Array, transfer?: UploadTransfer) {
  if (typeof XMLHttpRequest === "undefined")
    return fetch(address, {
      method: "PUT",
      credentials: "omit",
      redirect: "error",
      signal: transfer?.signal,
      headers: { "If-None-Match": "*", "X-Amz-Content-Sha256": sha },
      body: bytes as Uint8Array<ArrayBuffer>,
    }).then((response) => {
      void response.body?.cancel();
      return response.status;
    }, () => 0);
  return new Promise<number>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const signal = transfer?.signal;
    const abort = () => request.abort();
    const settle = (finish: () => void) => {
      signal?.removeEventListener("abort", abort);
      finish();
    };
    request.open("PUT", address);
    request.timeout = 120_000;
    request.setRequestHeader("If-None-Match", "*");
    request.setRequestHeader("X-Amz-Content-Sha256", sha);
    request.onload = () => settle(() => resolve(request.status));
    request.onerror = () => settle(() => resolve(0));
    request.ontimeout = request.onerror;
    request.onabort = () => settle(() => reject(signal?.reason ?? new DOMException("Upload cancelled", "AbortError")));
    request.upload.onprogress = (event) => transfer?.onProgress?.(event.loaded, bytes.byteLength);
    signal?.throwIfAborted();
    signal?.addEventListener("abort", abort, { once: true });
    request.send(bytes as Uint8Array<ArrayBuffer>);
  });
}

/** Uploads bytes and resolves to the upload's id. */
export async function upload(
  transport: WebTransport,
  bytes: Uint8Array,
  meta: { name?: string; type?: string; private?: boolean } = {},
  assertCurrent?: () => void,
  transfer?: UploadTransfer,
): Promise<string> {
  if (bytes.byteLength > maxUploadBytes)
    throw bridgeError(messages.tooLarge, webErrorCodes.tooLarge);
  const current = () => {
    transfer?.signal.throwIfAborted();
    assertCurrent?.();
  };
  const fetch = (path: string, init: RequestInit) =>
    transport.fetch(path, transfer ? { ...init, signal: transfer.signal } : init, current);
  const post = async (path: string, body: unknown) => {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await readJson(response);
    if (!response.ok) throw apiError(response.status, json);
    return apiValue(response.status, json) as Record<string, unknown>;
  };
  current();
  const sha = await sha256Hex(bytes);
  const started = await post(webPaths.uploads, {
    name: meta.name ?? "data",
    size: bytes.byteLength,
    type: meta.type ?? "application/octet-stream",
    sha256: sha,
    ...(meta.private ? { private: true } : { direct: true }),
  });
  current();
  if (meta.private && started?.private !== true)
    throw bridgeError("Private upload staging is unavailable.", webErrorCodes.methodUnavailable);
  const id = typeof started?.id === "string" ? started.id : "";
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id))
    throw bridgeError("The upload could not start.");
  const base = `${webPaths.uploads}/${id}`;
  if (!meta.private && started.upload && typeof started.upload === "object" &&
      "url" in started.upload && typeof started.upload.url === "string") {
    const address = attachmentObjectURL(started.upload.url);
    for (let attempt = 0; ; attempt++) {
      current();
      const status = await putObject(address, sha, bytes, transfer);
      current();
      if (status >= 200 && status < 300 || status === 412) break;
      if (attempt === 2 || status !== 0 && status !== 429 && status < 500)
        throw bridgeError("The file could not be uploaded. Try again.");
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    await post(`${base}/complete`, {});
    current();
    transfer?.onProgress?.(bytes.byteLength, bytes.byteLength);
    return id;
  }
  if (bytes.byteLength === 0) {
    await post(`${base}/complete`, {});
    current();
    return id;
  }
  const size = webLimits.uploadChunkBytes;
  const count = Math.max(1, Math.ceil(bytes.byteLength / size));
  for (let index = 0; index < count; index++) {
    const chunk = bytes.subarray(index * size, (index + 1) * size);
    const response = await fetch(`${base}/chunks/${index}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: chunk as Uint8Array<ArrayBuffer>,
    });
    if (!response.ok) throw apiError(response.status, await readJson(response));
    current();
    transfer?.onProgress?.(Math.min((index + 1) * size, bytes.byteLength), bytes.byteLength);
  }
  await post(`${base}/complete`, {});
  current();
  return id;
}

/** Replaces large Uint8Arrays in `value` with uploads (depth-first). */
async function lift(
  value: unknown,
  transport: WebTransport,
  hint: { name?: string; avatarPhoto?: boolean },
  assertCurrent?: () => void,
): Promise<unknown> {
  assertCurrent?.();
  if (
    hint.avatarPhoto &&
    typeof value === "string" &&
    value.startsWith("data:image/") &&
    value.length > inlineBytes
  ) {
    return {
      $avatarPhoto: {
        $upload: await upload(transport, new TextEncoder().encode(value), {
          name: "avatar",
        }, assertCurrent),
      },
    };
  }
  if (value instanceof Uint8Array) {
    if (value.byteLength <= inlineBytes) return value;
    const ref: UploadRef = { $upload: await upload(transport, value, hint, assertCurrent) };
    return ref;
  }
  if (Array.isArray(value))
    return Promise.all(value.map((item) => lift(item, transport, hint, assertCurrent)));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value))
      Object.defineProperty(out, key, {
        value: await lift(item, transport, {
          ...hint,
          avatarPhoto: key === "avatarPhoto",
        }, assertCurrent),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return out;
  }
  return value;
}

/** Whether any Uint8Array in `value` is over the inline size. */
function hasLargeBytes(value: unknown, seen = 0, avatarPhoto = false): boolean {
  if (seen > 64) return false;
  if (
    avatarPhoto &&
    typeof value === "string" &&
    value.startsWith("data:image/")
  )
    return value.length > inlineBytes;
  if (value instanceof Uint8Array) return value.byteLength > inlineBytes;
  if (Array.isArray(value))
    return value.some((v) => hasLargeBytes(v, seen + 1));
  if (value && typeof value === "object")
    return Object.entries(value).some(([key, item]) =>
      hasLargeBytes(item, seen + 1, key === "avatarPhoto"),
    );
  return false;
}

/**
 * The JSON body of an RPC call. Large bytes are uploaded first; the first
 * string argument names the upload when it looks like a file name
 * (`addAttachmentData(name, data)`).
 */
export async function encodeCall(
  args: unknown[],
  transport: WebTransport,
  assertCurrent?: () => void,
): Promise<string> {
  assertCurrent?.();
  // A left-out argument stays left out: JSON would turn a trailing
  // undefined into null, which the desktop's handlers (on the runner) read
  // as a value and refuse (saveProject(project, undefined) failed "The
  // request was not valid." on the web, 2026-10-21).
  let end = args.length;
  while (end > 0 && args[end - 1] === undefined) end--;
  args = end === args.length ? args : args.slice(0, end);
  let prepared = args;
  if (hasLargeBytes(args)) {
    const name =
      typeof args[0] === "string" && args[0].length <= 500
        ? args[0]
        : undefined;
    prepared = (await lift(args, transport, { name }, assertCurrent)) as unknown[];
  }
  assertCurrent?.();
  return JSON.stringify(rpcRequest(prepared));
}
