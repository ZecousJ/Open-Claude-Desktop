export const desktopAttachmentObject = "attachment_object";

export function attachmentObjectURL(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password)
    throw Error("The attachment address is invalid.");
  return url.href;
}

/** Reads an immutable object, resuming from the bytes already received. */
export async function readAttachmentObject(address: string, size: number, signal?: AbortSignal) {
  const url = attachmentObjectURL(address);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(90_000);
    try {
      const response = await fetch(url, {
        credentials: "omit",
        redirect: "error",
        headers: offset ? { Range: `bytes=${offset}-` } : undefined,
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
      if (
        response.status !== (offset ? 206 : 200) ||
        offset && response.headers.get("Content-Range") !== `bytes ${offset}-${size - 1}/${size}` ||
        response.body === null
      ) {
        await response.body?.cancel();
        throw Error("The attachment could not be downloaded.");
      }
      const reader = response.body.getReader();
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          if (offset + next.value.byteLength > size)
            throw Error("The attachment exceeded its declared size.");
          bytes.set(next.value, offset);
          offset += next.value.byteLength;
        }
        if (offset === size) return bytes;
      } finally {
        await reader.cancel().catch(() => {});
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (attempt === 2) throw error;
    }
  }
  throw Error("The attachment download is incomplete.");
}
