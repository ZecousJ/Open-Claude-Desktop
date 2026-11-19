import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { skillImportLimits } from "../../shared/skill-import";
import { maxSkillFolderFiles } from "./skill-folder";
import { assertSkillPathPrivate } from "./skill-private";

export class SkillArchiveLimitError extends Error {
  constructor() {
    super("Skill archives can contain up to 500 files and 30 MB.");
  }
}

export async function readSkillArchive({
  skillPath,
  archiveFolder,
  profileRoot,
}: {
  skillPath: string;
  archiveFolder: string;
  profileRoot?: string;
}): Promise<Buffer> {
  if (!path.isAbsolute(skillPath) || path.basename(skillPath) !== "SKILL.md")
    throw Error("The installed skill is missing SKILL.md.");
  const folder = fs.realpathSync(path.dirname(skillPath));
  if (profileRoot !== undefined)
    assertSkillPathPrivate(
      { store: { root: profileRoot }, window: undefined },
      folder,
    );

  const zip = new JSZip();
  let files = 0;
  let bytes = 0;
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(full, name);
      else if (entry.isFile()) {
        const fd = fs.openSync(
          full,
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
        );
        try {
          const stat = fs.fstatSync(fd);
          if (!stat.isFile())
            throw Error("The skill file changed while it was being read.");
          files++;
          bytes += stat.size;
          if (files > maxSkillFolderFiles || bytes > skillImportLimits.bytes)
            throw new SkillArchiveLimitError();
          const data = Buffer.alloc(stat.size);
          let offset = 0;
          while (offset < data.length) {
            const read = fs.readSync(
              fd,
              data,
              offset,
              data.length - offset,
              offset,
            );
            if (read === 0)
              throw Error("The skill file changed while it was being read.");
            offset += read;
          }
          if (fs.fstatSync(fd).size !== stat.size)
            throw Error("The skill file changed while it was being read.");
          zip.file(name, data, { createFolders: false });
        } finally {
          fs.closeSync(fd);
        }
      }
    }
  };
  walk(folder, archiveFolder);
  if (!zip.file(`${archiveFolder}/SKILL.md`))
    throw Error("The installed skill is missing SKILL.md.");
  return zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
}
