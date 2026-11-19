import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { CustomSlashCommand } from "../../shared/composer-api";
import { splitPromptArguments } from "../../shared/custom-command-expansion";
import { FileTooLargeError } from "../artifacts/generated-files";
import { RemoteFileReadError, type RemoteWorkspace } from "./remote-workspace";

const posix = path.posix;
const commandName = /^\w[\w-]{0,63}$/;
const maxSourceCommands = 256;
const maxCommandBytes = 64 * 1024;
const frontmatter = z.object({
  name: z.string().optional(),
  "argument-hint": z.string().optional().catch(undefined),
  arguments: z.array(z.string()).optional(),
  "user-invocable": z.boolean().optional(),
  context: z.string().optional(),
  hooks: z.unknown().optional(),
  "allowed-tools": z.unknown().optional(),
  model: z.unknown().optional(),
  agent: z.unknown().optional(),
});

type CommandOrigin = "(user)" | "(project)";
type MarkdownCommand = Omit<CustomSlashCommand, "source"> & {
  source: "prompt";
  file: string;
  body: string;
  arguments?: string[];
};
type CodexSkill = Omit<CustomSlashCommand, "source"> & { source: "skill" };
export type SshSlashCommand = MarkdownCommand | CodexSkill;

const runtimeCatalog = z.object({
  data: z.array(z.object({
    skills: z.array(z.object({
      name: z.string(),
      path: z.string(),
      enabled: z.boolean().optional(),
    })),
  })),
});

async function optionalRemoteFile<T>(read: Promise<T>) {
  try {
    return await read;
  } catch (error) {
    if (error instanceof RemoteFileReadError || error instanceof FileTooLargeError) return;
    throw error;
  }
}

function readMarkdown(text: string) {
  const header = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  const body = (header ? text.slice(header[0].length) : text).trim();
  if (!body || body.includes("\0")) return;
  try {
    const metadata = frontmatter.safeParse(header ? parseYaml(header[1]) ?? {} : {});
    if (metadata.success) return { metadata: metadata.data, body };
  } catch {
    return;
  }
}

export async function sshSlashCommands({
  workspace, home, project, names, codexSkills,
}: {
  workspace: Pick<RemoteWorkspace, "listDirectoryInside" | "readFileInside">;
  home: string;
  project?: string;
  names?: string[];
  codexSkills?: unknown;
}): Promise<SshSlashCommand[]> {
  const result = new Map<string, SshSlashCommand>();
  const roots: { root: string; description: CommandOrigin }[] = [{ root: home, description: "(user)" }];
  if (project && project !== home) roots.push({ root: project, description: "(project)" });
  const wanted = names?.filter(name => commandName.test(name));
  const sources = [".claude/skills", ".claude/commands", ".agents/skills"] as const;
  const catalog = runtimeCatalog.safeParse(codexSkills);
  for (const source of sources) {
    for (const { root, description } of roots) {
      if (wanted?.every(name => result.has(name))) return [...result.values()];
      const directory = posix.join(root, source);
      const codex = source === ".agents/skills";
      if (codex && catalog.success) {
        const skills = catalog.data.data.flatMap(({ skills }) => skills);
        for (const skill of skills) {
          if (skill.enabled === false || !commandName.test(skill.name) || result.has(skill.name) ||
              (wanted && !wanted.includes(skill.name)) || !skill.path.startsWith(`${directory}/`) ||
              skills.some(other => other.name === skill.name && (other.path !== skill.path || other.enabled === false))) continue;
          result.set(skill.name, { name: skill.name, description, source: "skill" });
        }
        continue;
      }
      const folders = source !== ".claude/commands";
      const listing = !wanted || codex
        ? await optionalRemoteFile(workspace.listDirectoryInside(root, directory)) : undefined;
      const candidates = wanted && !codex ? wanted : (listing?.entries ?? []).flatMap(({ name, kind }) => {
        if (folders && kind === "folder") return [name];
        if (!folders && kind === "file" && name.endsWith(".md")) return [name.slice(0, -3)];
        return [];
      });
      const limited = candidates.filter(name => commandName.test(name) && !result.has(name)).slice(0, maxSourceCommands);
      for (let i = 0; i < limited.length; i += 8) {
        const commands = await Promise.all(limited.slice(i, i + 8).map(async (name): Promise<SshSlashCommand | undefined> => {
          const file = folders ? posix.join(directory, name, "SKILL.md") : posix.join(directory, `${name}.md`);
          const bytes = await optionalRemoteFile(workspace.readFileInside(root, file, maxCommandBytes, { followLinks: true }));
          if (!bytes) return;
          const markdown = readMarkdown(bytes.toString("utf8"));
          if (!markdown) return;
          const { metadata, body } = markdown;
          if (codex) {
            const skillName = metadata.name;
            if (!skillName || !commandName.test(skillName) || wanted && !wanted.includes(skillName)) return;
            return { name: skillName, description, source: "skill" };
          }
          if (metadata["user-invocable"] === false || metadata.context === "fork" ||
              metadata.hooks !== undefined || metadata["allowed-tools"] !== undefined ||
              metadata.model !== undefined || metadata.agent !== undefined ||
              /(?:^|\s)!`[^`\n]+`|^`{3}!/m.test(body)) return;
          return { name, description, source: "prompt", file, body, arguments: metadata.arguments,
            argumentHint: metadata["argument-hint"]?.slice(0, 200) };
        }));
        for (const command of commands) {
          if (command && !result.has(command.name)) result.set(command.name, command);
        }
      }
    }
  }
  return [...result.values()];
}

export function expandSshMarkdownCommand(command: MarkdownCommand, argumentText: string, project?: string) {
  const args = argumentText.trim();
  const positional = splitPromptArguments(args);
  const base = posix.dirname(command.file);
  let used = false;
  const expanded = command.body.replace(
    /(\\)?\$(ARGUMENTS(?:\[(\d+)\])?|\d+|[A-Za-z_][\w-]*|\{CLAUDE_(?:SKILL|PROJECT)_DIR\})/g,
    (token, escaped: string | undefined, key: string, index: string | undefined, offset: number) => {
      if (key === "{CLAUDE_SKILL_DIR}") return base;
      if (key === "{CLAUDE_PROJECT_DIR}") return project ?? token;
      const position = index ?? (/^\d+$/.test(key) ? key : undefined);
      const named = command.arguments?.indexOf(key) ?? -1;
      if (key !== "ARGUMENTS" && position === undefined && named < 0) return token;
      if (escaped && command.body[offset - 1] !== "\\") return token.slice(1);
      const value = key === "ARGUMENTS" ? args : position !== undefined ? positional[Number(position)] : positional[named] ?? "";
      if (value === undefined) return token;
      used = true;
      return (escaped ?? "") + value;
    },
  ).trim();
  const context = `Use the instructions for /${command.name} from ${command.file}. Resolve its relative references from ${base}.`;
  return `${context}\n\n${expanded}${args && !used ? `\n\nARGUMENTS: ${args}` : ""}`;
}
