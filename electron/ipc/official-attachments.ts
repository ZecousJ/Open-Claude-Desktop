import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AppContext, IpcHandle } from "../app/app-context";
import { storeAttachment, attachmentFileName } from "../engine/composer-files";
import { attachmentRefusal } from "../../shared/client-policy-rules";
import { attachmentKind } from "../../shared/client-policy";
import type { Attachment } from "../../shared/types";

const attachmentBytes = 64 * 1024 * 1024;

export function storeOfficialAttachments(
  ctx: Pick<AppContext, "store" | "policy" | "selectedAttachments">,
  raw: unknown,
): Attachment[] {
  const inputs = z
    .array(
      z
        .object({
          name: z.string().min(1).max(500),
          data: z.instanceof(Uint8Array),
        })
        .strict(),
    )
    .max(12)
    .parse(raw);
  if (inputs.reduce((n, f) => n + f.data.length, 0) > attachmentBytes)
    throw Error("Combined attachments exceed 64 MB.");
  for (const f of inputs) {
    const denied = attachmentRefusal(
      attachmentFileName(f.name),
      f.data.length,
      ctx.policy(),
    );
    if (denied) throw Error(denied);
  }
  const root = path.join(ctx.store.root, "attachments"),
    stored: Attachment[] = [];
  try {
    for (const f of inputs) {
      const a = storeAttachment(root, f.name, f.data, ctx.policy());
      stored.push(a);
    }
    for (const a of stored) ctx.selectedAttachments.set(a.id, a);
    return stored;
  } catch (e) {
    for (const a of stored)
      fs.rmSync(path.join(root, a.id), { recursive: true, force: true });
    throw e;
  }
}

function restoredImageDigest(file: string, expected: fs.BigIntStats) {
  const matches = (stat: fs.BigIntStats) =>
    stat.isFile() &&
    stat.nlink === 1n &&
    stat.dev === expected.dev &&
    stat.ino === expected.ino &&
    stat.size === expected.size &&
    stat.mtimeNs === expected.mtimeNs &&
    stat.ctimeNs === expected.ctimeNs;
  const changed = () =>
    Error("Saved attachment changed while checking its image.");
  const namedMatches = () =>
    fs.realpathSync(file) === file &&
    matches(fs.lstatSync(file, { bigint: true }));
  if (!matches(expected)) throw changed();
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY |
      (fs.constants.O_NOFOLLOW ?? 0) |
      (fs.constants.O_NONBLOCK ?? 0),
  );
  try {
    if (!matches(fs.fstatSync(fd, { bigint: true })) || !namedMatches())
      throw changed();
    const hash = createHash("sha256");
    let remaining = Number(expected.size);
    const chunk = Buffer.alloc(Math.min(remaining, 64 * 1024));
    while (remaining > 0) {
      const length = fs.readSync(
        fd,
        chunk,
        0,
        Math.min(remaining, chunk.length),
        null,
      );
      if (length === 0) throw changed();
      hash.update(chunk.subarray(0, length));
      remaining -= length;
    }
    if (!matches(fs.fstatSync(fd, { bigint: true })) || !namedMatches())
      throw changed();
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

export function registerOfficialAttachmentHandlers(
  handle: IpcHandle,
  ctx: AppContext,
) {
  handle("officialStoreCodeAttachments", (raw: unknown) =>
    storeOfficialAttachments(ctx, raw),
  );
  handle(
    "officialRestoreCodeAttachments",
    (raw: unknown, rawOptions?: unknown) => {
      const ids = z.array(z.string().uuid()).max(12).parse(raw);
      const options = z
        .strictObject({ hashImages: z.literal(true) })
        .optional()
        .parse(rawOptions);
      const root = fs.realpathSync(path.join(ctx.store.root, "attachments"));
      const restored = ids.map((id) => {
        const dir = path.join(root, id),
          real = fs.realpathSync(dir);
        if (real !== dir) throw Error("Attachment location changed.");
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        if (entries.length !== 1 || !entries[0].isFile())
          throw Error("Saved attachment is missing or invalid.");
        const name = entries[0].name,
          file = path.join(dir, name),
          actual = fs.realpathSync(file);
        if (actual !== file) throw Error("Attachment location changed.");
        const stamp = fs.lstatSync(file, { bigint: true });
        if (!stamp.isFile())
          throw Error("Saved attachment is missing or invalid.");
        const size = Number(stamp.size),
          denied = attachmentRefusal(name, size, ctx.policy());
        if (denied) throw Error(denied);
        const attachment: Attachment = {
          id,
          name,
          path: file,
          size,
          kind: attachmentKind(path.extname(name).slice(1)),
        };
        return { attachment, stamp };
      });
      if (
        options &&
        restored.reduce((total, row) => total + row.attachment.size, 0) >
          attachmentBytes
      )
        throw Error("Combined attachments exceed 64 MB.");
      const result = restored.map(({ attachment, stamp }) =>
        options && attachment.kind === "image"
          ? {
              ...attachment,
              imageSha256: restoredImageDigest(attachment.path, stamp),
            }
          : attachment,
      );
      for (const { attachment } of restored)
        ctx.selectedAttachments.set(attachment.id, attachment);
      return result;
    },
  );
}
