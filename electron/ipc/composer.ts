import type { EnvironmentRef } from "../../shared/types";
import {
  linkChatGitHubRepository,
  registerChatGitHub,
} from "../git/chat-github";
import { restoreFiles } from "../engine/rewind-files";
import { rewindChanges } from "../../shared/rewind-files";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AppContext, IpcHandle } from "../app/app-context";
import type {
  CustomSlashCommand,
  SlashCommandList,
} from "../../shared/composer-api";
import {
  imagePreview,
  mentionFiles,
  storeAttachment,
} from "../engine/composer-files";
import { maxSideQuestionLength } from "../engine/side-chat-model";
import {
  contextSources,
  environmentInput,
  workspaceFsFor,
} from "../workspace/workspace-fs";

/** A branch or commit given to `/review`: a plain name, never an option. */
const reviewRef = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\w][\w./@+-]*$/);
export const reviewTarget = z.discriminatedUnion("type", [
  z.object({ type: z.literal("uncommittedChanges") }).strict(),
  z.object({ type: z.literal("baseBranch"), branch: reviewRef }).strict(),
  z
    .object({
      type: z.literal("commit"),
      sha: z.string().regex(/^[0-9a-fA-F]{4,64}$/),
      title: z.string().max(500).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("custom"),
      instructions: z.string().min(1).max(20000),
    })
    .strict(),
]);

/**
 * Composer calls: pasted and dropped attachments, image thumbnails, @ file
 * lists limited to the folders the person chose, compact and steer. Their
 * bridge names are declared in `shared/composer-api.ts`.
 */
export function registerComposerHandlers(handle: IpcHandle, ctx: AppContext) {
  const githubReady = registerChatGitHub(ctx);
  handle(
    "linkChatGitHubRepository",
    async (repository: unknown, branch: unknown) => {
      await githubReady();
      return linkChatGitHubRepository(ctx, repository, branch);
    },
  );
  const id = z.string().min(1).max(500);
  handle(
    "resolveCodeNewTask",
    (
      conversationId: unknown,
      offerId: unknown,
      choice: unknown,
      remember: unknown,
    ) =>
      ctx.engine.resolveCodeNewTask(
        id.parse(conversationId),
        id.parse(offerId),
        z.enum(["here", "new_session"]).parse(choice),
        z.boolean().optional().parse(remember),
      ),
  );
  const known = (attachmentId: string) => {
    const found = ctx.selectedAttachments.get(attachmentId);
    if (!found)
      throw new Error("This attachment is no longer available. Add it again.");
    return found;
  };
  handle("compactConversation", (conversationId: unknown) =>
    ctx.engine.compactConversation(id.parse(conversationId)),
  );
  handle("rewindConversation", (conversationId: unknown, turnId: unknown) =>
    ctx.engine.rewindConversation(
      id.parse(conversationId),
      turnId === undefined || turnId === null
        ? undefined
        : z.string().min(1).max(200).parse(turnId),
    ),
  );
  handle("restoreRewindCode", (conversationId: unknown, turnId: unknown) => {
    const c = ctx.store.conversation(id.parse(conversationId));
    if (
      c.mode !== "code" ||
      (c.environment && c.environment.kind !== "local") ||
      !c.cwd
    )
      throw new Error(
        "Only a Code session on this computer can restore its code.",
      );
    if (c.turns.some((t) => t.status === "inProgress"))
      throw new Error("Rewind is unavailable while Claudex is working");
    const index = c.turns.findIndex(
      (t) => t.id === z.string().min(1).max(200).parse(turnId),
    );
    if (index < 0) throw new Error("Nothing to rewind to yet");
    return restoreFiles(rewindChanges(c.turns.slice(index)), c.cwd);
  });
  handle("swapRewind", (conversationId: unknown) =>
    ctx.engine.swapRewind(id.parse(conversationId)),
  );
  handle("runShellCommand", (conversationId: unknown, command: unknown) =>
    ctx.engine.runShellCommand(
      id.parse(conversationId),
      z.string().min(1).max(100000).parse(command),
    ),
  );
  handle(
    "startReview",
    (conversationId: unknown, target: unknown, prompt: unknown) =>
      ctx.engine.startReview(
        id.parse(conversationId),
        reviewTarget.parse(target),
        prompt === undefined || prompt === null
          ? undefined
          : z.string().max(10000).parse(prompt),
      ),
  );
  handle("forkConversation", (conversationId: unknown, options: unknown) => {
    const parsed = z
      .object({
        turnId: z.string().min(1).max(200).optional(),
        prompt: z.string().max(200000).optional(),
      })
      .optional()
      .parse(options ?? undefined);
    return ctx.engine.forkConversation(
      id.parse(conversationId),
      parsed?.turnId,
      parsed?.prompt,
    );
  });
  handle("handOffConversation", (conversationId: unknown) =>
    ctx.engine.handOffConversation(id.parse(conversationId)),
  );
  handle(
    "askSideChat",
    (conversationId: unknown, sideChatId: unknown, question: unknown) =>
      ctx.engine.askSideChat(
        id.parse(conversationId),
        id.parse(sideChatId),
        z.string().max(maxSideQuestionLength).parse(question),
      ),
  );
  handle("interruptSideChat", (conversationId: unknown, sideChatId: unknown) =>
    ctx.engine.interruptSideChat(
      id.parse(conversationId),
      id.parse(sideChatId),
    ),
  );
  handle("endSideChat", (conversationId: unknown, sideChatId: unknown) =>
    ctx.engine.endSideChat(id.parse(conversationId), id.parse(sideChatId)),
  );
  handle(
    "steerTurn",
    (conversationId: unknown, text: unknown, attachmentIds: unknown) => {
      const ids = z.array(z.string().max(500)).max(12).parse(attachmentIds);
      return ctx.engine.steerTurn(
        id.parse(conversationId),
        z.string().max(200000).parse(text),
        ids.map(known),
      );
    },
  );
  handle(
    "addAttachmentData",
    (name: unknown, data: unknown, options: unknown) => {
      if (!(data instanceof Uint8Array) || data.byteLength > 64 * 1024 * 1024)
        throw new Error("This file can't be attached.");
      const { pasted } = z
        .object({ pasted: z.boolean().optional() })
        .optional()
        .parse(options) ?? { pasted: false };
      const attachment = storeAttachment(
        path.join(ctx.store.root, "attachments"),
        z.string().min(1).max(500).parse(name),
        data,
        ctx.policy(),
        pasted,
      );
      ctx.selectedAttachments.set(attachment.id, attachment);
      return attachment;
    },
  );
  handle("attachmentPreview", (attachmentId: unknown) =>
    imagePreview(known(id.parse(attachmentId))),
  );
  handle("mentionFiles", (scope: unknown, query: unknown) => {
    const { conversationId, folder, environment } = z
      .object({
        conversationId: z.string().min(1).max(500).optional(),
        folder: z.string().min(1).max(4096).optional(),
        // The chosen folder's environment (R9: a folder on an SSH host).
        environment: environmentInput.optional(),
      })
      .parse(scope);
    let root: string | undefined;
    let where: EnvironmentRef | undefined = environment;
    if (conversationId) {
      const conversation = ctx.store.conversation(conversationId);
      root = conversation.mode === "code" ? conversation.cwd : undefined;
      where = conversation.environment;
    } else if (folder) {
      // Only a folder the person chose (or one already in use) is listed.
      ctx.allowedFolder(folder, environment);
      root = folder;
    }
    if (!root) return [];
    const text = z.string().max(300).parse(query);
    if (where?.kind !== "ssh") return mentionFiles(root, text);
    return workspaceFsFor(contextSources(ctx), where).mentionFiles(root, text);
  });
  // The prompts folder as it really is, and only while it stays inside the
  // profile: a link put in its place (on a runner the agent can write
  // codex-home) reads nothing.
  const promptsFolder = () => {
    const folder = path.join(ctx.store.root, "codex-home", "prompts");
    try {
      const real = fs.realpathSync(folder);
      const root = fs.realpathSync(ctx.store.root);
      return real.startsWith(root + path.sep) ? real : "";
    } catch {
      return "";
    }
  };
  handle(
    "listSlashCommands",
    async (scope: unknown): Promise<SlashCommandList> => {
      const { conversationId, folder } = z
        .object({
          conversationId: z.string().min(1).max(500).optional(),
          folder: z.string().min(1).max(4096).optional(),
        })
        .parse(scope ?? {});
      let cwd: string | undefined;
      if (conversationId) cwd = ctx.store.conversation(conversationId).cwd;
      else if (folder) {
        ctx.allowedFolder(folder);
        cwd = folder;
      }
      const prompts = listCustomPrompts(promptsFolder());
      let skills: CustomSlashCommand[] = [];
      try {
        const listed = await ctx.engine.rpc?.call(
          "skills/list",
          cwd ? { cwds: [cwd] } : {},
        );
        skills = slashSkills(listed?.data ?? []);
      } catch {
        // The runtime is starting or stopped: the palette lists prompts only.
      }
      const taken = new Set(prompts.map((prompt) => prompt.name));
      return {
        commands: [
          ...prompts,
          ...skills.filter((skill) => !taken.has(skill.name)),
        ],
        usageCredits: Boolean(ctx.remote),
      };
    },
  );
  handle("readCustomPrompt", (name: unknown) =>
    readCustomPrompt(promptsFolder(), z.string().max(200).parse(name)),
  );
}

/** Bigger prompt files are not offered (and never read whole). */
export const maxPromptBytes = 64 * 1024;
const maxPrompts = 200;
/** A name that can follow "/" in the composer (no spaces). */
export const slashNamePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * A prompt file's front matter (`description`, `argument-hint`) and body,
 * as Codex custom prompts write them.
 */
export function parsePromptFile(text: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  const meta: Record<string, string> = {};
  if (match)
    for (const line of match[1].split(/\r?\n/)) {
      const pair = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
      if (pair)
        meta[pair[1].toLowerCase()] = pair[2]
          .trim()
          .replace(/^(["'])(.*)\1$/, "$2");
    }
  const body = match ? text.slice(match[0].length) : text;
  const firstLine =
    body
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find(Boolean) ?? "";
  return {
    body,
    description: (meta.description || firstLine).slice(0, 200),
    argumentHint: meta["argument-hint"]?.slice(0, 200) || undefined,
  };
}

/**
 * The file's text when it is a small, regular UTF-8 file; otherwise
 * undefined. Never follows a link or blocks on a pipe: on a runner the
 * agent can write this folder.
 */
function promptText(file: string) {
  let handle: number | undefined;
  try {
    handle = fs.openSync(
      file,
      fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW ?? 0) |
        (fs.constants.O_NONBLOCK ?? 0),
    );
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.size > maxPromptBytes) return;
    return new TextDecoder("utf-8", { fatal: true }).decode(
      fs.readFileSync(handle),
    );
  } catch {
    return;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

/** `<folder>/<name>.md` custom prompts, sorted by name. */
export function listCustomPrompts(folder: string): CustomSlashCommand[] {
  if (!folder) return [];
  let names: string[];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return [];
  }
  const prompts: CustomSlashCommand[] = [];
  for (const file of names.sort()) {
    if (prompts.length >= maxPrompts) break;
    if (!file.endsWith(".md")) continue;
    const name = file.slice(0, -3);
    if (!slashNamePattern.test(name)) continue;
    const text = promptText(path.join(folder, file));
    if (text === undefined) continue;
    const { description, argumentHint } = parsePromptFile(text);
    prompts.push({
      name,
      description: description || "Custom prompt",
      source: "prompt",
      ...(argumentHint ? { argumentHint } : {}),
    });
  }
  return prompts;
}

export function readCustomPrompt(folder: string, name: string) {
  if (!folder || !slashNamePattern.test(name)) return null;
  const text = promptText(path.join(folder, `${name}.md`));
  return text === undefined ? null : parsePromptFile(text).body;
}

/** Enabled skills from `skills/list`, once each, under names "/" can take. */
export function slashSkills(groups: unknown): CustomSlashCommand[] {
  const seen = new Set<string>();
  const skills: CustomSlashCommand[] = [];
  const list = Array.isArray(groups) ? groups : [];
  for (const group of list)
    for (const skill of Array.isArray(group?.skills) ? group.skills : []) {
      const name = typeof skill?.name === "string" ? skill.name : "";
      if (skill?.enabled === false || !slashNamePattern.test(name)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      const description =
        typeof skill.shortDescription === "string" && skill.shortDescription
          ? skill.shortDescription
          : typeof skill.description === "string"
            ? skill.description
            : "";
      skills.push({
        name,
        description: description.slice(0, 200) || "Skill",
        source: "skill",
      });
    }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
