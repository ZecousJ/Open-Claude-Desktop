import type { Attachment } from "../../shared/types";
import type { ElementPick } from "../../shared/browser";
import { api } from "../desktop-api";
import { addFile } from "../composer/attachment-input";
import { elementPickText } from "./browser-model";

/**
 * Select element (R8-G): the element the person picked goes into the message as
 * attachments, so the composer stays clean: a text file with its place,
 * selector, text, styles and HTML, and, when the panel could take one, a
 * picture of it that shows as a thumbnail like any attached image. No capture
 * shows where the original puts it; attachments are the closest captured place.
 */

/** The file name for a picked element: "element-button.md". */
export function elementPickFileName(pick: Pick<ElementPick, "tag">) {
  const tag =
    pick.tag
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "")
      .slice(0, 24) || "node";
  return `element-${tag}.md`;
}

/** The bytes of a base64 string. */
function bytesOf(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Whether a screenshot from the panel is a plain base64 PNG worth attaching (at most 4 MB). */
export function pickPicture(pick: Pick<ElementPick, "screenshotPngBase64">) {
  const data = pick.screenshotPngBase64;
  return data && data.length <= 5_600_000 && /^[A-Za-z0-9+/]*={0,2}$/.test(data)
    ? data
    : undefined;
}

/**
 * Keeps the picked element as attachments: the description, then its
 * picture. Throws when the description can't be kept (attachments turned
 * off by the administrator, a size limit); the caller then falls back to
 * writing it into the message.
 */
export async function attachElementPick(
  pick: ElementPick,
): Promise<Attachment[]> {
  const text = new TextEncoder().encode(elementPickText(pick));
  const description = await api.addAttachmentData(
    elementPickFileName(pick),
    text,
  );
  const data = pickPicture(pick);
  if (!data) return [description];
  try {
    const picture = await addFile(
      new File(
        [bytesOf(data) as BlobPart],
        `element-${pick.tag || "node"}.png`,
        {
          type: "image/png",
        },
      ),
    );
    return [description, picture];
  } catch {
    // The picture is extra; the description is what Claude needs.
    return [description];
  }
}
