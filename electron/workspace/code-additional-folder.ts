import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const localCodeDirectory = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => path.isAbsolute(value) && !/^[\\/]{2}|[\0\r\n]/.test(value),
  );

export const remoteCodeDirectory = z
  .string()
  .max(4096)
  .refine(value => value.startsWith("/") && !/^[\\/]{2}|[\x00-\x1f\x7f]/.test(value));

export const codeDirectories = z.array(z.union([localCodeDirectory, remoteCodeDirectory])).min(1).max(20);

export function resolveLocalCodeDirectory(folder: string): string {
  const resolved = fs.realpathSync.native(folder);
  if (!fs.statSync(resolved).isDirectory())
    throw Error("Choose a directory to add to this Code session.");
  return resolved;
}
