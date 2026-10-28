import { nativeImage } from "electron";
import type { Transcoder } from "./screenshots";

/** Scales with Electron's image support and encodes as JPEG (quality 80). */
export const electronTranscoder: Transcoder = (data, _mimeType, maxEdge) => {
  const image = nativeImage.createFromBuffer(data);
  if (image.isEmpty()) throw new Error("The screenshot couldn't be read.");
  const { width, height } = image.getSize();
  const factor = Math.min(1, maxEdge / Math.max(width, height, 1));
  const scaled =
    factor < 1
      ? image.resize({
          width: Math.max(1, Math.round(width * factor)),
          height: Math.max(1, Math.round(height * factor)),
          quality: "good",
        })
      : image;
  const size = scaled.getSize();
  return {
    data: scaled.toJPEG(80),
    mimeType: "image/jpeg",
    width: size.width,
    height: size.height,
    sourceWidth: width,
    sourceHeight: height,
  };
};
