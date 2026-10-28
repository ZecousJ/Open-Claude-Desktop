/** The pixel size a PNG declares in its header, or undefined when it isn't one. */
export function pngSize(
  data: Uint8Array,
): { width: number; height: number } | undefined {
  // 8-byte signature, then the IHDR chunk: length, "IHDR", width, height.
  if (data.length < 24) return undefined;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (signature.some((byte, index) => data[index] !== byte)) return undefined;
  if (String.fromCharCode(...data.subarray(12, 16)) !== "IHDR")
    return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  // A display is never zero-sized or bigger than 16 k.
  if (!width || !height || width > 16384 || height > 16384) return undefined;
  return { width, height };
}

/** What the screenshot scaler returns: the encoded picture and its size. */
export interface ScaledImage {
  data: Buffer;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
}

/**
 * Scales a PNG to `width`×`height` pixels (never up) and encodes it. The
 * app passes Electron's `nativeImage`; tests pass a stand-in.
 */
export type ImageScaler = (
  png: Buffer,
  size: { width: number; height: number },
) => ScaledImage;
