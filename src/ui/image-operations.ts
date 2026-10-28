import { surface } from "../../shared/host";

/** PNG clipboard conversion and original-byte saving. */
export async function imageBlob(src: string) {
  const response = await fetch(src);
  if (!response.ok) throw new Error(`Failed to load image: ${response.status}`);
  return response.blob();
}

export async function pngBlob(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = reject;
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2d canvas context unavailable");
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) =>
          result
            ? resolve(result)
            : reject(new Error("canvas.toBlob returned null")),
        "image/png",
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function copyImage(src: string) {
  if (surface === "web") return window.desktop.copyImage(src);
  const blob = await pngBlob(await imageBlob(src));
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  await window.desktop.copyImage(dataUrl);
}

export function imageFileName(
  mime: string,
  fileName?: string,
  now = Date.now(),
) {
  const format = [
    "png",
    "jpeg",
    "jpg",
    "gif",
    "webp",
    "avif",
    "heic",
    "bmp",
  ].find((name) => mime.toLowerCase().includes(name));
  const extension = format === "jpeg" ? "jpg" : (format ?? "png");
  return fileName &&
    /\.(png|jpe?g|jfif|gif|webp|bmp|avif|heic|heif|tiff?|ico)$/i.test(fileName)
    ? fileName
    : `image-${now}.${extension}`;
}

export async function saveImage(src: string, fileName?: string) {
  const blob = await imageBlob(src);
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = imageFileName(blob.type, fileName);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
