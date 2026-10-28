import JSZip from "jszip";
import type { SkillImportFile } from "../../shared/skill-import";
import { t } from "../i18n";

export interface SkillSourceFile {
  name: string;
  webkitRelativePath: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export async function skillSourceFiles(
  files: SkillSourceFile[],
): Promise<SkillImportFile[]> {
  const paths = new Map(files.map((file) => [file.webkitRelativePath, file]));
  const roots = new Set<string>();
  const manifests = files.filter((file) =>
    /(?:^|\/)skills-plugin\/[^/]+\/[^/]+\/manifest\.json$/.test(
      file.webkitRelativePath,
    ),
  );
  for (const manifest of manifests) {
    if (manifest.size > 1024 * 1024) continue;
    const base = manifest.webkitRelativePath.slice(0, -"manifest.json".length);
    let skills: unknown;
    try {
      skills = JSON.parse(
        new TextDecoder().decode(await manifest.arrayBuffer()),
      ).skills;
    } catch {
      continue;
    }
    if (!Array.isArray(skills)) continue;
    for (const skill of skills) {
      if (
        skill?.creatorType !== "user" ||
        typeof skill.name !== "string" ||
        !skill.name ||
        skill.name.includes("\\") ||
        skill.name
          .split("/")
          .some((part: string) => !part || part === "." || part === "..")
      )
        continue;
      const root = `${base}${skill.name}/`;
      if (paths.has(`${root}SKILL.md`)) roots.add(root);
    }
  }
  if (!manifests.length) {
    for (const file of files)
      if (file.name === "SKILL.md")
        roots.add(file.webkitRelativePath.slice(0, -"SKILL.md".length));
  }
  const result: SkillImportFile[] = [];
  for (const root of [...roots].slice(0, 200)) {
    const zip = new JSZip();
    const entries = files
      .filter((file) => file.webkitRelativePath.startsWith(root))
      .map((file) => ({
        file,
        path: file.webkitRelativePath.slice(root.length),
      }))
      .filter(
        ({ path }) =>
          !path.split("/").some((part) => part.startsWith(".")) &&
          !/^(?:hooks|monitors|workflows)\/|^(?:hooks\.json|\.mcp\.json|\.lsp\.json)$/iu.test(
            path,
          ),
      );
    if (
      entries.length > 200 ||
      entries.reduce((sum, { file }) => sum + file.size, 0) > 30 * 1024 * 1024
    )
      throw Error(t("Skill files are too large to upload."));
    for (const { file, path } of entries)
      zip.file(path, await file.arrayBuffer(), { createFolders: false });
    result.push({
      name: `${root.split("/").filter(Boolean).at(-1) ?? "skill"}.skill`,
      data: await zip.generateAsync({
        type: "uint8array",
        compression: "DEFLATE",
      }),
    });
  }
  return result;
}
