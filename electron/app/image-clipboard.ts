import { z } from "zod";

const imageData = z
  .string()
  .max(32_000_000)
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/);

/** Native image copying. */
export async function copyNativeImage<Image extends { isEmpty(): boolean }>(
  raw: unknown,
  decode: (dataUrl: string) => Image,
  write: (image: Image) => void | Promise<void>,
) {
  const image = decode(imageData.parse(raw));
  if (image.isEmpty()) throw new Error("Image decode failed");
  await write(image);
}
