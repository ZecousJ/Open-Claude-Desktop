import { pluginSlug } from "../../shared/duplicate-name";
import { pluginArchiveLimit } from "../../shared/plugin-upload";

export interface PluginDraftFile {
  path: string;
  content: string;
}
export const starterSkillPath = "skills/skill/SKILL.md";

/** O16 the account-create editor seed. */
export function pluginSkillSeed(name = "", description = "") {
  return [
    "---",
    `name: ${JSON.stringify(name)}`,
    ...(description.trim()
      ? [`description: ${JSON.stringify(description.trim())}`]
      : []),
    "---",
    "",
    `# ${name}`,
    "",
    "",
  ].join("\n");
}
export const initialPluginFiles = (): PluginDraftFile[] => [
  { path: starterSkillPath, content: pluginSkillSeed() },
];
const pathKey = (path: string) => path.normalize("NFC").toLowerCase();
export const invalidPluginPath = "Enter a path like scripts/run.py.";
export const duplicatePluginPath = "A file with that path already exists.";

/** A ZIP member must remain one relative file on every supported desktop. */
export function pluginDraftPathError(
  raw: string,
  files: readonly PluginDraftFile[],
  previous?: string,
): string | undefined {
  const path = raw.trim();
  if (
    !path ||
    path.length > 4096 ||
    /[\\\u0000-\u001f\u007f<>:"|?*]/.test(path) ||
    path
      .split("/")
      .some(
        (part) => !part || part === "." || part === ".." || /[. ]$/.test(part),
      )
  )
    return invalidPluginPath;
  const key = pathKey(path);
  if (
    files.some((file) => {
      if (file.path === previous) return false;
      const other = pathKey(file.path);
      return (
        key === other ||
        key.startsWith(`${other}/`) ||
        other.startsWith(`${key}/`)
      );
    })
  )
    return duplicatePluginPath;
}

function skillMetadata(content: string, name: string, description?: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  const lines = match?.[1].split(/\r?\n/) ?? [];
  // Replace scalar or block values while preserving unrelated front matter.
  for (const [key, value] of [
    ["name", name],
    ...(description === undefined ? [] : [["description", description.trim()]]),
  ]) {
    const index = lines.findIndex(
      (line) => /^(name|description)\s*:/.exec(line)?.[1] === key,
    );
    const entry = value ? `${key}: ${JSON.stringify(value)}` : undefined;
    if (index < 0) {
      if (entry) lines.push(entry);
    } else {
      let end = index + 1;
      while (end < lines.length && (/^\s/.test(lines[end]) || !lines[end]))
        end++;
      lines.splice(index, end - index, ...(entry ? [entry] : []));
    }
  }
  const body = match ? content.slice(match[0].length) : `\n${content}`;
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

/** Adapt the existing archive API to the account editor's name/files contract.
 * cdbe53168:3188–3204 relocates the starter folder only when unambiguous. */
export function pluginArchiveFiles(
  files: readonly PluginDraftFile[],
  typedName: string,
  description: string,
): PluginDraftFile[] {
  const name = pluginSlug(typedName);
  if (!name) throw Error("Name your plugin before saving.");
  if (!files.length) throw Error("Add a file before saving.");
  if (files.length > 5000) throw Error("The plugin has too many files.");
  for (const file of files) {
    const error = pluginDraftPathError(file.path, files, file.path);
    if (error) throw Error(error);
  }
  const prefix = `skills/${name}/`;
  const customTarget = files.some(
    (file) =>
      file.path.startsWith(prefix) && !file.path.startsWith("skills/skill/"),
  );
  const output = files.flatMap((file): PluginDraftFile[] => {
    const starter = file.path.startsWith("skills/skill/");
    const untouched = starter && file.content === pluginSkillSeed();
    if (untouched && customTarget) return [];
    const path =
      starter && !customTarget
        ? prefix + file.path.slice("skills/skill/".length)
        : file.path;
    if (untouched)
      return [{ path, content: pluginSkillSeed(name, description) }];
    if (/^skills\/[^/]+\/SKILL\.md$/.test(path))
      return [
        {
          path,
          content: skillMetadata(
            file.content,
            path.split("/")[1],
            starter ? description : undefined,
          ),
        },
      ];
    return [{ ...file, path }];
  });
  const manifestPath = ".claude-plugin/plugin.json";
  const original = output.find((file) => file.path === manifestPath);
  let manifest: Record<string, unknown> = {};
  if (original) {
    try {
      const value = JSON.parse(original.content);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw Error();
      manifest = value;
    } catch {
      throw Error("The plugin manifest must contain a JSON object.");
    }
  }
  // The metadata fields describe the plugin being saved, including a custom manifest.
  const content = JSON.stringify(
    {
      ...manifest,
      name,
      description: description.trim(),
      ...(manifest.skills === undefined &&
      output.some((file) => file.path.startsWith("skills/"))
        ? { skills: "./skills/" }
        : {}),
    },
    null,
    2,
  );
  const archive = [
    ...output.filter((file) => file.path !== manifestPath),
    { path: manifestPath, content },
  ];
  if (archive.length > 5000) throw Error("The plugin has too many files.");
  const seen = new Set<string>();
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const file of archive) {
    const error = pluginDraftPathError(file.path, archive, file.path);
    if (error) throw Error(error);
    const key = pathKey(file.path);
    if (seen.has(key)) throw Error(duplicatePluginPath);
    seen.add(key);
    bytes += encoder.encode(file.content).byteLength;
  }
  if (bytes > pluginArchiveLimit)
    throw Error("The plugin files exceed the archive size limit.");
  return archive;
}
