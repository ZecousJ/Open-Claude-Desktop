export interface SkillFileFolder {
  name: string;
  path: string;
  folders: SkillFileFolder[];
  files: string[];
}

/** Relative paths from readSkill, without inventing a file or a directory. */
export function skillFileTree(paths: string[]): SkillFileFolder {
  const root: SkillFileFolder = { name: "", path: "", folders: [], files: [] };
  for (const file of new Set(paths)) {
    const parts = file.split("/");
    let folder = root;
    parts.slice(0, -1).forEach((name, index) => {
      let child = folder.folders.find((entry) => entry.name === name);
      if (!child) {
        child = {
          name,
          path: parts.slice(0, index + 1).join("/"),
          folders: [],
          files: [],
        };
        folder.folders.push(child);
      }
      folder = child;
    });
    folder.files.push(file);
  }
  const sort = (folder: SkillFileFolder) => {
    folder.files.sort((a, b) =>
      a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a.localeCompare(b),
    );
    folder.folders.sort((a, b) => a.name.localeCompare(b.name));
    folder.folders.forEach(sort);
  };
  sort(root);
  return root;
}

/** The observed bundle editor's column limits. */
export const skillFileListWidth = { default: 244, min: 160, max: 520 };
export function clampSkillFileListWidth(
  value: number,
  containerWidth?: number,
) {
  const limit =
    containerWidth && containerWidth > 0
      ? Math.min(skillFileListWidth.max, containerWidth * 0.6)
      : skillFileListWidth.max;
  const width = Number.isFinite(value)
    ? Math.round(value)
    : skillFileListWidth.default;
  return Math.max(skillFileListWidth.min, Math.min(limit, width));
}
