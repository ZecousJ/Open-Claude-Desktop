import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Attachment } from "../../../shared/types";
import { attachmentKind } from "../../../shared/client-policy";
import { storeCodeAttachments } from "./code-attachments";

const attachmentBytes = 64 * 1024 * 1024;
type AttachmentBytes = { name: string; data: Uint8Array };
type RestoredAttachment = Attachment & { imageSha256?: string };

function imageDigest(file: AttachmentBytes) {
  return createHash("sha256").update(file.data).digest("hex");
}

function unpairedInlineImages(
  inline: AttachmentBytes[],
  restored: RestoredAttachment[],
  picked: AttachmentBytes[],
) {
  if (!inline.length) return inline;
  const available = new Map<string, number>();
  for (const digest of [
    ...restored.flatMap((file) => (file.imageSha256 ? [file.imageSha256] : [])),
    ...picked
      .filter(
        (file) => attachmentKind(path.extname(file.name).slice(1)) === "image",
      )
      .map(imageDigest),
  ])
    available.set(digest, (available.get(digest) ?? 0) + 1);
  return inline.filter((file) => {
    const digest = imageDigest(file);
    const count = available.get(digest) ?? 0;
    if (!count) return true;
    available.set(digest, count - 1);
    return false;
  });
}

/** Official Cowork paths are accepted only when previously minted by the host's
 * account attachment store (e.g. FileSystem.savePastedFile), or backed by a
 * one-shot trusted File selection. No arbitrary renderer path is read and no
 * external-folder grant is established. */
export async function storeCoworkAttachments(
  root: string | undefined,
  call: (name: string, ...args: unknown[]) => Promise<unknown>,
  images: unknown,
  files: unknown,
  selected?: (
    paths: string[],
    budget: number,
  ) => Array<{ name: string; data: Uint8Array }>,
): Promise<Attachment[]> {
  // Retain the internal byte-object extension; it is not the official picker
  // wire format. The shared validator rejects mixed path/object payloads.
  if (
    !Array.isArray(files) ||
    !files.length ||
    !files.every((f) => typeof f === "string")
  )
    return storeCodeAttachments(call, images, files);
  if (!root) throw Error("The account attachment store is unavailable.");
  if (files.length > 12) throw Error("Attach at most 12 files.");
  const base = path.resolve(root, "attachments");
  const storedPaths: string[] = [];
  const selectedPaths: string[] = [];
  const ids: string[] = [];
  for (const file of files as string[]) {
    if (!path.isAbsolute(file) || path.normalize(file) !== file)
      throw Error(
        "Select the attachment again; this path was not stored by this account.",
      );
    const relative = path.relative(base, file);
    const parts = relative.split(path.sep);
    if (
      !relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative)
    ) {
      if (
        parts.length !== 2 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          parts[0],
        ) ||
        !parts[1] ||
        parts[1] === "." ||
        parts[1] === ".."
      )
        throw Error(
          "Select the attachment again; this path was not stored by this account.",
        );
      ids.push(parts[0]);
      storedPaths.push(file);
    } else {
      if (!selected)
        throw Error(
          "Select the attachment again; this path was not stored by this account.",
        );
      selectedPaths.push(file);
    }
  }
  if (new Set(files).size !== files.length)
    throw Error("Duplicate attachment paths are not supported.");
  let inline: AttachmentBytes[] = [];
  await storeCodeAttachments(
    async (_name, payload) => {
      inline = payload as AttachmentBytes[];
      return [];
    },
    images,
    [],
  );
  // The existing host handler rechecks account ownership, regular files,
  // symlinks, type and size policy. No filesystem read is based on `file` here.
  const restored = (
    ids.length
      ? await call(
          "officialRestoreCodeAttachments",
          ids,
          ...(inline.length ? [{ hashImages: true }] : []),
        )
      : []
  ) as RestoredAttachment[];
  if (
    !Array.isArray(restored) ||
    restored.length !== storedPaths.length ||
    restored.some(
      (a, i) =>
        a.id !== ids[i] ||
        (a.path !== storedPaths[i] &&
          a.path !==
            path.join(
              fs.realpathSync(base),
              path.relative(base, storedPaths[i]),
            )) ||
        !Number.isSafeInteger(a.size) ||
        a.size < 0,
    )
  )
    throw Error("The saved attachment no longer matches its selected path.");
  const size = restored.reduce((n, a) => n + a.size, 0);
  if (size > attachmentBytes) throw Error("Combined attachments exceed 64 MB.");
  const picked = selectedPaths.length
    ? selected!(selectedPaths, attachmentBytes - size)
    : [];
  // The renderer sends local images both inline and as named file paths.
  const uniqueInline = unpairedInlineImages(inline, restored, picked);
  if (files.length + uniqueInline.length > 12)
    throw Error("Attach at most 12 files.");
  const payload = [...uniqueInline, ...picked];
  if (
    size + payload.reduce((total, file) => total + file.data.length, 0) >
    attachmentBytes
  )
    throw Error("Combined attachments exceed 64 MB.");
  const added = payload.length
    ? ((await call("officialStoreCodeAttachments", payload)) as Attachment[])
    : [];
  if (!Array.isArray(added) || added.length !== payload.length)
    throw Error("The selected files were not stored completely.");
  const byPath = new Map<string, Attachment>();
  storedPaths.forEach((file, index) => {
    const { imageSha256: _digest, ...attachment } = restored[index];
    byPath.set(file, attachment);
  });
  selectedPaths.forEach((file, index) =>
    byPath.set(file, added[uniqueInline.length + index]),
  );
  // The user may refer to "the first attachment". Preserve the image order
  // followed by the exact file-list order, even when sources are interleaved.
  return [
    ...added.slice(0, uniqueInline.length),
    ...files.map((file: string) => byPath.get(file)!),
  ];
}
