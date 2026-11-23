import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { imageType } from "../../electron/artifacts/generated-blobs";
import { attachmentRefusal } from "../../shared/client-policy-rules";
import type { WebAppContext } from "./web-app-context";

const extensions = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const mediaType = z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const coworkFileAttachments = z.array(z.strictObject({
  file_uuid: z.string().uuid(), file_name: z.string().min(1).max(500), is_image: z.boolean(),
})).max(12).optional();
export const coworkImageInput = z.strictObject({ base64: z.string().min(4), media_type: mediaType });
const imageBlock = z.strictObject({
  type: z.literal("image"),
  source: z.strictObject({ type: z.literal("base64"), media_type: mediaType, data: z.string().min(4) }),
});
export const coworkMessageContent = z.union([
  z.string(),
  z.array(z.union([z.strictObject({ type: z.literal("text"), text: z.string() }), imageBlock])).min(1).max(128),
]);

export function readCoworkContent(content: z.infer<typeof coworkMessageContent>) {
  const text: string[] = [], images: z.infer<typeof coworkImageInput>[] = [];
  for (const block of typeof content === "string" ? [{ type: "text", text: content } as const] : content) {
    if (block.type === "text") text.push(block.text);
    else images.push({ base64: block.source.data, media_type: block.source.media_type });
  }
  return { message: text.join("\n"), images };
}

export function prepareCoworkAttachments(
  ctx: WebAppContext,
  files: NonNullable<z.infer<typeof coworkFileAttachments>>,
  images: z.infer<typeof coworkImageInput>[],
) {
  const ids = files.map(file => file.file_uuid.toLowerCase());
  if (ids.length + images.length > 12 || new Set(ids).size !== ids.length)
    throw Error("Invalid Cowork attachment selection.");
  const documents = files.map(({ is_image }, index) => {
    const id = ids[index];
    const file = ctx.selectedAttachments.get(id);
    if (!file || file.id !== id || (file.kind === "image") !== is_image ||
        attachmentRefusal(file.name, file.size, ctx.policy()))
      throw Error("Attachment unavailable.");
    const expected = path.join(fs.realpathSync(path.join(ctx.store.root, "attachments")), file.id, file.name);
    if (fs.realpathSync(file.path) !== expected || fs.statSync(expected).size !== file.size)
      throw Error("Attachment changed.");
    return file;
  });
  const imageFiles = images.map(({ base64, media_type }, index) => {
    const data = Buffer.from(base64, "base64");
    const header = data.subarray(0, 6).toString("ascii");
    const mime = header === "GIF87a" || header === "GIF89a" ? "image/gif" : imageType(data);
    const name = `image-${index + 1}.${extensions[media_type]}`;
    if (mime !== media_type || data.toString("base64") !== base64 || attachmentRefusal(name, data.length, ctx.policy()))
      throw Error("Invalid image attachment.");
    return { name, data };
  });
  return { documents, imageFiles };
}
