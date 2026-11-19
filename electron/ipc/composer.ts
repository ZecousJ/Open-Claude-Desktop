import { readOwnedTurnAttachment } from "./owned-turn-attachment";
import { releaseOfficialCodeNewTask, updateOfficialCodeCloudOffer } from "./official-code-new-task";
import { codeSideSessionPlacement } from "../../shared/official-code-side-session";
import { codeModelProposalAction, codeModelProposalId } from "../../shared/official-code-model-proposal";
import { actOnCodeModelProposal } from "../engine/code-model-proposals";
import type { EnvironmentRef } from "../../shared/types";
import {
  linkChatGitHubRepository,
  registerChatGitHub,
} from "../git/chat-github";
import { rewindCodeFiles } from "../engine/code-file-rewind";
import { beginCodeSessionLifecycle, assertCodeSessionSendAvailable } from "../conversations/code-lifecycle-guard";
import { restoreFiles } from "../engine/rewind-files";
import { rewindChanges } from "../../shared/rewind-files";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { incognitoDraftId, prepareIncognitoUploadFolder } from "../workspace/incognito-upload";
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
import { officialCodeSendStart, type CodeSendStart } from "../engine/code-send-start";
import { changeCodeClearHistory, switchCodeRewindMark } from "../engine/engine-history";
import {
  contextSources,
  environmentInput,
  workspaceFsFor,
} from "../workspace/workspace-fs";

const codeRewindTarget = z.union([z.string().min(1).max(200), z.object({ turnId: z.string().min(1).max(200), itemId: z.string().min(1).max(500) }).strict()]);

const attachmentMimes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
};
const attachmentMime = (name: string) =>
  attachmentMimes[path.extname(name).slice(1).toLowerCase()] ??
  "application/octet-stream";

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
 * Composer calls (package WP4a): pasted and dropped attachments, image
 * thumbnails, @ file lists limited to the folders the person chose,
 * compact and steer. Their bridge names are declared in
 * `shared/composer-api.ts`.
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
  // The adapter persists the original input in its visible held-message
  // queue before releasing this legacy, otherwise invisible suggestion.
  handle(
    "officialReleaseCodeNewTask",
    (rawId: unknown, rawOffer: unknown, rawText: unknown) =>
      releaseOfficialCodeNewTask(ctx, rawId, rawOffer, rawText),
  );
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
  handle("officialResolveCodeNewTask", (rawId: unknown, rawOffer: unknown, rawChoice: unknown, current: unknown, rawPlacement?: unknown) => {
    if (typeof current !== "function" || !current()) throw Error("Code session is no longer available.");
    const conversationId = id.parse(rawId);
    const offerId = id.parse(rawOffer);
    if (ctx.store.conversation(conversationId).codeNewTask?.nativeInput === undefined)
      throw Error("This suggestion is no longer available.");
    const placement = codeSideSessionPlacement.optional().parse(rawPlacement);
    return ctx.engine.resolveCodeNewTask(conversationId, offerId, z.enum(["here", "new_session"]).parse(rawChoice), false, () => current() === true, placement);
  });
  handle("officialUpdateCodeCloudOffer", (rawId: unknown, rawOffer: unknown, operation: unknown, current: unknown) => {
    if (typeof current !== "function" || !current()) throw Error("Code session is no longer available.");
    return updateOfficialCodeCloudOffer(ctx, rawId, rawOffer, operation);
  });
  handle("officialCodeModelProposal", (parentId: unknown, taskId: unknown, action: unknown, current: unknown) => {
    if (typeof current !== "function" || !current()) throw Error("The Code session is no longer available.");
    return actOnCodeModelProposal(ctx, z.string().uuid().parse(parentId),
      codeModelProposalId.parse(taskId), codeModelProposalAction.parse(action), () => current() === true);
  });
  const known = (attachmentId: string) => {
    const found = ctx.selectedAttachments.get(attachmentId);
    if (!found)
      throw new Error("This attachment is no longer available. Add it again.");
    return found;
  };
  handle("compactConversation", (conversationId: unknown, requestId: unknown,
    extra?: { [officialCodeSendStart]?: CodeSendStart }) => {
    const accountEngine = ctx.engine, store = ctx.store, identity = ctx.accountActivationIdentity,
      accountId = ctx.activeAccount?.id;
    const sessionId = id.parse(conversationId);
    const start = extra?.[officialCodeSendStart];
    const engineForSession = () => ctx.remote && start ? ctx.engineFor(sessionId) : ctx.engine;
    const engine = engineForSession();
    const current = () => identity !== undefined && identity === ctx.accountActivationIdentity &&
      ctx.accountRetiring === false && ctx.store === store && ctx.engine === accountEngine &&
      engineForSession() === engine && !!accountId && ctx.activeAccount?.id === accountId;
    if (!current()) throw Error("The account changed. Reopen the conversation before compacting.");
    return engine.compactConversation(sessionId, current,
      requestId === undefined ? undefined : id.parse(requestId), start);
  });
  handle("officialCodeClearHistory", (rawId: unknown, rawAction: unknown, nativeLease?: () => boolean) => {
    if (typeof nativeLease !== "function") throw Error("This Code operation requires the native session.");
    const accountEngine = ctx.engine, store = ctx.store, identity = ctx.accountActivationIdentity,
      owner = ctx.activeAccount?.id, conversation = store.conversation(id.parse(rawId));
    const remote = conversation.environment?.kind === "ssh" || conversation.environment?.kind === "wsl";
    const engine = remote ? ctx.engineFor(conversation.id) : accountEngine;
    const current = () => identity !== undefined && identity === ctx.accountActivationIdentity &&
      ctx.accountRetiring === false && ctx.store === store && ctx.engine === accountEngine &&
      (!remote || ctx.engines.running(conversation.id) === engine) &&
      !!owner && ctx.activeAccount?.id === owner &&
      (!conversation.sessionAuthors || (conversation.sessionAuthors.ownerAccountUuid === owner &&
        conversation.sessionAuthors.viewerAccountUuid === owner)) &&
      nativeLease();
    return changeCodeClearHistory(engine, conversation.id, z.enum(["clear", "restore"]).parse(rawAction), current);
  });
  handle("rewindConversation", (conversationId: unknown, turnId: unknown) => {
    const engine = ctx.engine, store = ctx.store, identity = ctx.accountActivationIdentity,
      accountId = ctx.activeAccount?.id;
    const current = () => identity !== undefined && identity === ctx.accountActivationIdentity &&
      ctx.accountRetiring === false && ctx.store === store && ctx.engine === engine &&
      !!accountId && ctx.activeAccount?.id === accountId;
    if (!current()) throw Error("The account changed. Reopen the conversation before rewinding.");
    return engine.rewindConversation(id.parse(conversationId),
      turnId === undefined || turnId === null ? undefined : codeRewindTarget.parse(turnId), current);
  });
  handle("officialCodeSwitchRewindMark", (rawId: unknown, markId: unknown, lease?: () => boolean) => {
    if (typeof lease !== "function") throw Error("This Code operation requires the native session.");
    const engine = ctx.engine, store = ctx.store, identity = ctx.accountActivationIdentity,
      owner = ctx.activeAccount?.id, c = store.conversation(id.parse(rawId));
    const current = () => identity !== undefined && identity === ctx.accountActivationIdentity &&
      ctx.accountRetiring === false && ctx.store === store && ctx.engine === engine &&
      !!owner && ctx.activeAccount?.id === owner &&
      (!c.sessionAuthors || c.sessionAuthors.ownerAccountUuid === owner) && lease();
    return switchCodeRewindMark(engine, c.id, z.string().min(1).max(500).parse(markId), current);
  });
  handle("officialCodeRewindFiles", (conversationId: unknown, turnId: unknown, dryRun: unknown, lease?: () => boolean) => {
    if (typeof lease !== "function" || !lease()) throw Error("The Code session is no longer available.");
    const c = ctx.store.conversation(id.parse(conversationId));
    if (c.mode !== "code" || !c.cwd || c.incognito || c.cloudHosted || c.cloudEnvironmentId ||
        c.environment && c.environment.kind !== "local" ||
        c.sessionAuthors && c.sessionAuthors.ownerAccountUuid !== ctx.activeAccount?.id)
      throw Error("An owned local Code session is required.");
    ctx.store.assertLocalCodeLifecycleAvailable();
    assertCodeSessionSendAvailable(c);
    ctx.engine.assertIdle(c.id);
    if (ctx.engine.pendingSend) throw Error("Wait for the pending Code task before restoring files.");
    const target = codeRewindTarget.parse(turnId);
    const index = c.turns.findIndex(turn => turn.id === (typeof target === "string" ? target : target.turnId));
    if (index < 0) throw Error("The file restore prompt no longer exists.");
    const turns = c.turns.slice(index);
    if (typeof target !== "string") {
      const itemIndex = turns[0].items.findIndex(item => item.id === target.itemId);
      if (itemIndex < 0) throw Error("The file restore prompt no longer exists.");
      turns[0] = { ...turns[0], items: turns[0].items.slice(itemIndex) };
    }
    const release = beginCodeSessionLifecycle(c);
    try {
      const preview = z.boolean().parse(dryRun);
      const result = rewindCodeFiles(rewindChanges(turns), c.cwd, preview);
      if (!preview && result.canRewind) {
        ctx.store.commitLocalCodeHistory(c, { codeFilesRewoundTo: target, updatedAt: Date.now() }, undefined, lease);
        ctx.engine.changed(c, true);
      }
      return result;
    } finally { release(); }
  });
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
  handle("swapRewind", (conversationId: unknown) => {
    const engine = ctx.engine, store = ctx.store, identity = ctx.accountActivationIdentity,
      accountId = ctx.activeAccount?.id;
    const current = () => identity !== undefined && identity === ctx.accountActivationIdentity &&
      ctx.accountRetiring === false && ctx.store === store && ctx.engine === engine &&
      !!accountId && ctx.activeAccount?.id === accountId;
    if (!current()) throw Error("The account changed. Reopen the conversation before undoing rewind.");
    return engine.swapRewind(id.parse(conversationId), current);
  });
  handle("runShellCommand", (conversationId: unknown, command: unknown) =>
    ctx.engine.runShellCommand(
      id.parse(conversationId),
      z.string().min(1).max(100000).parse(command),
    ),
  );
  handle(
    "startReview",
    (conversationId: unknown, target: unknown, prompt: unknown, options?: {
      [officialCodeSendStart]?: CodeSendStart;
      uuid?: string;
    }) => {
      const engine = ctx.engine;
      const store = ctx.store;
      const identity = ctx.accountActivationIdentity;
      const start = options?.[officialCodeSendStart];
      return engine.startReview(
        id.parse(conversationId),
        reviewTarget.parse(target),
        prompt === undefined || prompt === null
          ? undefined
          : z.string().max(10000).parse(prompt),
        start ? {
          start,
          uuid: id.parse(options?.uuid),
          current: () => ctx.engine === engine && ctx.store === store &&
            ctx.accountActivationIdentity === identity && !ctx.accountRetiring,
        } : undefined,
      );
    },
  );
  handle("forkConversation", (conversationId: unknown, options: unknown) => {
    const parsed = z
      .object({
        turnId: z.string().min(1).max(200).optional(),
        branchId: z.string().min(1).max(200).optional(),
        prompt: z.string().max(200000).optional(),
        conversationId: z.string().uuid().optional(),
        cwd: z.string().min(1).max(32768).optional(),
        before: z.union([
          z.object({ turnId: z.string().min(1).max(200), itemId: z.string().min(1).max(500).optional() }).strict(),
          z.object({ turnId: z.string().min(1).max(200), importedRowId: z.string().min(1).max(500) }).strict(),
        ]).optional(),
      })
      .optional()
      .parse(options ?? undefined);
    const engine = ctx.engine, store = ctx.store, identity = ctx.accountActivationIdentity,
      accountId = ctx.activeAccount?.id;
    const current = () => identity !== undefined && identity === ctx.accountActivationIdentity &&
      ctx.accountRetiring === false && ctx.store === store && ctx.engine === engine &&
      !!accountId && ctx.activeAccount?.id === accountId;
    if (!current()) throw Error("The account changed. Reopen the conversation before forking.");
    return engine.forkConversation(
      id.parse(conversationId),
      parsed?.turnId,
      parsed?.prompt,
      parsed?.branchId,
      current,
      parsed,
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
    "officialCoworkSteer",
    (conversationId: unknown, raw: unknown, current: () => boolean) => {
      const input = z.strictObject({
        text: z.string().max(200000),
        attachmentIds: z.array(z.string().max(500)).max(12),
        messageId: z.string().min(1).max(500).optional(),
      }).parse(raw);
      const store = ctx.store;
      const engine = ctx.engine;
      const conversation = store.conversation(id.parse(conversationId));
      if (conversation.mode !== "cowork" || conversation.cloudHosted ||
          typeof current !== "function" || !current())
        throw Error("The Cowork session changed before sending.");
      assertCodeSessionSendAvailable(conversation);
      return engine.steerTurn(
        conversation.id, input.text, input.attachmentIds.map(known), undefined,
        { eventId: input.messageId, current: () =>
          current() && ctx.store === store && ctx.engine === engine &&
          !ctx.accountRetiring && store.conversations.includes(conversation) },
      );
    },
  );
  handle(
    "addAttachmentData",
    (name: unknown, data: unknown, options: unknown) => {
      if (!(data instanceof Uint8Array) || data.byteLength > 64 * 1024 * 1024)
        throw new Error("This file can't be attached.");
      const { pasted, incognitoDraft } = z
        .object({ pasted: z.boolean().optional(), incognitoDraft: incognitoDraftId.optional() })
        .optional()
        .parse(options) ?? { pasted: false };
      const attachment = storeAttachment(
        incognitoDraft ? prepareIncognitoUploadFolder(ctx.store.root, incognitoDraft) : path.join(ctx.store.root, "attachments"),
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
  handle("turnAttachment", (conversationId: unknown, attachmentId: unknown) => {
    const found = readOwnedTurnAttachment(ctx.store, id.parse(conversationId), id.parse(attachmentId));
    if (!found) return null;
    return {
      name: found.attachment.name,
      mime: attachmentMime(found.attachment.name),
      data: found.data,
    };
  });
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
    if (where?.kind !== "ssh" && where?.kind !== "wsl") return mentionFiles(root, text);
    return workspaceFsFor(contextSources(ctx), where).mentionFiles(root, text);
  });
  handle(
    "listSlashCommands",
    async (scope: unknown): Promise<SlashCommandList> => {
      const { conversationId, folder, strictSources } = z
        .object({
          conversationId: z.string().min(1).max(500).optional(),
          folder: z.string().min(1).max(4096).optional(),
          strictSources: z.boolean().optional(),
        })
        .parse(scope ?? {});
      let cwd: string | undefined;
      if (conversationId) cwd = ctx.store.conversation(conversationId).cwd;
      else if (folder) {
        ctx.allowedFolder(folder);
        cwd = folder;
      }
      const prompts = listCustomPrompts(customPromptsFolder(ctx.store.root, strictSources), strictSources);
      let skills: CustomSlashCommand[] = [];
      try {
        const engineForSession = () => conversationId ? ctx.engineFor(conversationId) : ctx.engine;
        const engine = engineForSession();
        const store = ctx.store;
        const identity = ctx.accountActivationIdentity;
        const current = () => engineForSession() === engine && ctx.store === store &&
          ctx.accountActivationIdentity === identity && !ctx.accountRetiring;
        if (strictSources && !engine.rpc) {
          const providerId = conversationId
            ? store.conversation(conversationId).providerId
            : store.settings.activeProviderId;
          const provider = store.settings.providers.find((item) => item.id === providerId);
          if (!provider) throw Error("The model service is unavailable.");
          await engine.ensure(provider, { interactive: false, current });
        }
        const rpc = engine.rpc;
        const listed = await rpc?.call(
          "skills/list",
          cwd ? { cwds: [cwd] } : {},
        );
        if (strictSources && (!current() || engine.rpc !== rpc))
          throw Error("The account or Code connection changed. Try again.");
        if (strictSources && (!Array.isArray(listed?.data) || listed.data.some((group: unknown) => !group || typeof group !== "object" || !Array.isArray((group as { skills?: unknown }).skills) || ((group as {errors?: unknown[]}).errors?.length ?? 0) > 0)))
          throw Error("The skill command catalog is unavailable or malformed.");
        skills = slashSkills(listed?.data ?? []);
      } catch (error) {
        if (strictSources) throw error;
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
    readCustomPrompt(customPromptsFolder(ctx.store.root), z.string().max(200).parse(name)),
  );
}

export function customPromptsFolder(profileRoot: string, strict = false) {
  try {
    const real = fs.realpathSync(path.join(profileRoot, "codex-home", "prompts"));
    const root = fs.realpathSync(profileRoot);
    if (real.startsWith(root + path.sep)) return real;
    if (strict) throw Error("The prompt catalog is outside the active profile.");
    return "";
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return "";
  }
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
    const buffer = Buffer.alloc(maxPromptBytes + 1);
    const size = fs.readSync(handle, buffer, 0, buffer.length, 0);
    const after = fs.fstatSync(handle);
    if (size > maxPromptBytes || size !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) return;
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
  } catch {
    return;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

/** `<folder>/<name>.md` custom prompts, sorted by name. */
export function listCustomPrompts(folder: string, strict = false): CustomSlashCommand[] {
  if (!folder) return [];
  let names: string[];
  try {
    names = fs.readdirSync(folder);
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
  const prompts: CustomSlashCommand[] = [];
  for (const file of names.sort()) {
    if (prompts.length >= maxPrompts) {
      if (strict) throw Error("The prompt catalog exceeds its limit.");
      break;
    }
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

