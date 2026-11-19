import fs from "node:fs";
import path from "node:path";

const personalSkills = (root: string) =>
  path.join(root, "codex-home", "skills");
const stagedSkills = (home: string) =>
  path.join(home, "skills", "account-skills");

export function accountSkillsMount(profile: string, spaceHome: string) {
  return {
    host: personalSkills(profile),
    sandbox: stagedSkills(spaceHome),
    writable: false,
  };
}

export function spaceSkillPaths(profile: string, spaceHome: string) {
  const { host, sandbox } = accountSkillsMount(profile, spaceHome);
  if (!fs.existsSync(sandbox)) return;
  const source = fs.realpathSync.native(host);
  const mounted = fs.realpathSync.native(sandbox);
  const image = path.join("api-image", "SKILL.md");
  const managedImagePaths = {
    own: path.join(fs.realpathSync.native(spaceHome), "skills", image),
    mounted: path.join(mounted, image),
  };
  return {
    managedImagePaths,
    runtimePath(file: string) {
      const relative = path.relative(source, file);
      if (
        !relative ||
        relative.startsWith(".." + path.sep) ||
        relative === ".." ||
        path.isAbsolute(relative)
      )
        return file;
      return relative === image
        ? managedImagePaths.own
        : path.join(mounted, relative);
    },
  };
}
