import fs from "node:fs";
import path from "node:path";
const maximum = 100 * 1024 * 1024;
const same = (a: fs.Stats, b: fs.Stats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
/** Only call with a path just returned by the main-process OS picker. A
 * renderer path or filename is never accepted as selection provenance. */
export function readPickedExtensionArchive(file: string) {
  const fail = () => Error("Couldn’t open the extension file. Try again.");
  if (!path.isAbsolute(file) || !/\.(mcpb|dxt)$/i.test(file)) throw fail();
  const before = fs.lstatSync(file);
  const real = fs.realpathSync(file);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    !Number.isSafeInteger(before.size) ||
    before.size < 0 ||
    before.size > maximum
  )
    throw fail();
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile() ||
      !same(before, opened) ||
      !same(before, fs.lstatSync(file))
    )
      throw fail();
    const data = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < data.length) {
      const count = fs.readSync(fd, data, offset, data.length - offset, offset);
      if (!count) throw fail();
      offset += count;
    }
    if (
      !same(before, fs.fstatSync(fd)) ||
      !same(before, fs.lstatSync(file)) ||
      fs.realpathSync(file) !== real
    )
      throw fail();
    return { name: path.basename(file), data };
  } finally {
    fs.closeSync(fd);
  }
}
