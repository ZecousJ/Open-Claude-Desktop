import fs from "node:fs";
import path from "node:path";

export function organizationPluginSources(root: string) {
  const directory = path.join(root, "organization-plugins");
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o755 });
  if (!fs.lstatSync(directory).isDirectory())
    throw Error("The organization plugin sources directory is unavailable.");
  return directory;
}
