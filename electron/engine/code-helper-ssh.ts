import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { AppContext } from "../app/app-context";
import type { McpCallContext } from "../browser/mcp-server";
import { checkRemotePath } from "../ssh/remote-scripts";
import {
  codeHelperPermission,
  codeHelperPermissionInput,
} from "./code-helper-targets";
import { codeEffortLevels, effortForMode } from "../../shared/code-effort";
import type { Conversation, Turn } from "../../shared/types";

const sshInput = z.strictObject({
  initiation: z.literal("user_asked"),
  target: z.literal("ssh"),
  host: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(59),
  prompt: z.string().trim().min(1).max(200000),
  background: z.string().trim().min(80).max(200000),
  context: z.literal("fresh").optional(),
  cwd: z.string().min(1).max(1024).optional(),
  use_worktree: z.boolean().optional(),
  source_branch: z.string().min(1).max(255).optional(),
  branch_name: z.string().min(1).max(255).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  effort: z.enum(codeEffortLevels).optional(),
  wake_when_done: z.boolean().optional(),
  permission_mode: codeHelperPermissionInput.optional(),
});

export async function startCodeHelperSsh(
  ctx: AppContext,
  parent: Conversation,
  turn: Turn,
  args: unknown,
  call: McpCallContext,
  current: () => boolean,
  pending: Set<string>,
) {
  const parsed = sshInput.safeParse(args);
  if (!parsed.success)
    throw Error(
      "Provide a saved SSH host, a fresh prompt and at least 80 characters of background.",
    );
  const input = parsed.data,
    store = ctx.store,
    service = ctx.services.ssh;
  const permission = codeHelperPermission(
    store.settings,
    {
      ...parent,
      codePermissionMode: turn.codePermissionMode ?? parent.codePermissionMode,
    },
    input.permission_mode,
  );
  if (!service?.allowed()) throw Error("SSH connections are unavailable.");
  const hosts = service.hosts
    .list()
    .filter((host) => host.label === input.host);
  if (hosts.length !== 1)
    throw Error("Choose one saved SSH connection by its unique name.");
  const host = hosts[0],
    environment = { kind: "ssh" as const, hostId: host.id };
  const folder = checkRemotePath(input.cwd ?? host.defaultFolder);
  if (!input.use_worktree && (input.source_branch || input.branch_name))
    throw Error("source_branch and branch_name require a separate worktree.");
  if (
    input.source_branch &&
    (input.source_branch.startsWith("-") ||
      input.source_branch.startsWith("refs/") ||
      input.source_branch.trim() !== input.source_branch)
  )
    throw Error("source_branch must name an existing branch.");
  const provider = store.settings.providers.find(
    (row) => row.id === parent.providerId,
  );
  if (!provider) throw Error("The model service is unavailable.");
  const model = input.model ?? parent.model;
  if (![provider.model, ...provider.models, parent.model].includes(model))
    throw Error("This account can't use this model.");
  const effort =
    parent.effort ??
    store.projects.find((row) => row.id === parent.projectId)?.defaultEffort ??
    effortForMode(store.settings, "code");
  if (
    input.effort &&
    codeEffortLevels.indexOf(input.effort) > codeEffortLevels.indexOf(effort)
  )
    throw Error(
      "The new session's effort cannot exceed this session's effort.",
    );
  const facts = JSON.stringify({
    cwd: parent.cwd,
    providerId: parent.providerId,
    model: parent.model,
    effort: parent.effort,
    worktree: parent.worktree,
    permission: turn.codePermissionMode ?? parent.codePermissionMode,
  });
  const hostFacts = ({ lastUsedAt: _ignored, ...value }: typeof host) => value;
  const selectedHost = structuredClone(hostFacts(host));
  const providerFacts = JSON.stringify(provider);
  let trustStillValid: (() => boolean) | undefined;
  const fenced = () => {
    const selected = service.hosts
      .list()
      .filter((row) => row.label === input.host);
    if (
      !current() ||
      ctx.store !== store ||
      ctx.services.ssh !== service ||
      !service.allowed() ||
      selected.length !== 1 ||
      !isDeepStrictEqual(hostFacts(selected[0]), selectedHost) ||
      store.settings.providers.find((row) => row.id === parent.providerId) !==
        provider ||
      JSON.stringify(provider) !== providerFacts ||
      (trustStillValid && !trustStillValid()) ||
      (parent.effort ??
        store.projects.find((row) => row.id === parent.projectId)
          ?.defaultEffort ??
        effortForMode(store.settings, "code")) !== effort ||
      codeHelperPermission(
        store.settings,
        {
          ...parent,
          codePermissionMode:
            turn.codePermissionMode ?? parent.codePermissionMode,
        },
        input.permission_mode,
      ) !== permission ||
      JSON.stringify({
        cwd: parent.cwd,
        providerId: parent.providerId,
        model: parent.model,
        effort: parent.effort,
        worktree: parent.worktree,
        permission: turn.codePermissionMode ?? parent.codePermissionMode,
      }) !== facts
    )
      return false;
    try {
      ctx.allowedFolder(folder, environment);
      return true;
    } catch {
      return false;
    }
  };
  if (!fenced())
    throw Error("This SSH folder is not available. Nothing started.");
  if (pending.has(parent.id))
    throw Error(
      "A session start is already in progress. Check its result before retrying.",
    );
  pending.add(parent.id);
  const childId = randomUUID();
  try {
    const answer = await ctx.engine.requestAppApproval(
      parent.id,
      {
        threadId: parent.threadId,
        turnId: turn.id,
        serverName: "ccd_session",
        mode: "form",
        message: `Allow starting “${input.title}” on the saved SSH connection “${host.label}” in ${folder}${input.use_worktree ? " using a separate worktree" : ""}, with model ${model}?`,
        requestedSchema: {
          type: "object",
          properties: {
            decision: { type: "string", enum: ["once"], enumNames: ["Allow"] },
          },
          required: ["decision"],
        },
      },
      call.signal,
    );
    if (answer?.action !== "accept")
      throw Error("SSH placement was not approved. Nothing started.");
    if (!fenced())
      throw Error("The session or SSH placement changed. Nothing started.");
    const remote = ctx.engines.forEnvironment(environment);
    await ctx.engines.connectWorktreeHost(environment, false);
    if (!fenced())
      throw Error("The session or SSH placement changed. Nothing started.");
    const trust = await remote.remoteWorkspaceTrust(folder, false);
    trustStillValid = () =>
      !!remote.sshTrust?.roots(host.id).includes(trust.root);
    if (!trust.trusted || !fenced())
      throw Error("The SSH workspace is not trusted. Nothing started.");
    const child = await remote.send(
      {
        text: `${input.background}\n\n${input.prompt}`,
        attachments: [],
        mode: "code",
        environment,
        parentSessionId: parent.id,
        newConversationId: childId,
        codeHelperLink: {
          taskId: `task_${randomBytes(4).toString("hex")}`,
          title: input.title,
          parentTurnId: turn.id,
          wakeWhenDone: input.wake_when_done,
        },
        cwd: folder,
        providerId: parent.providerId,
        model,
        effort: input.effort ?? parent.effort,
        codePermissionMode: permission,
        worktree: input.use_worktree,
        worktreeBranch: input.source_branch,
        worktreeBranchHint: input.branch_name,
      },
      undefined,
      false,
      {
        current: fenced,
        interactive: false,
        newTaskResolved: true,
        verifyCodeHelperPlacement: async () => {
          const latest = await remote.remoteWorkspaceTrust(folder, false);
          if (
            !latest.trusted ||
            latest.root !== trust.root ||
            latest.folder !== trust.folder ||
            !fenced()
          )
            throw Error(
              "The trusted SSH folder changed. Check the session before retrying.",
            );
        },
      },
    );
    const saved = store.conversations.find((row) => row.id === child.id);
    if (saved?.turns.at(-1)?.status === "failed")
      return {
        session_id: `local_${child.id}`,
        title: saved.title,
        notice: "The session could not start. Check it before retrying.",
        failed: true,
      };
    return {
      session_id: `local_${child.id}`,
      title: saved?.title ?? child.title,
      notice: "The child can post its result to this session.",
    };
  } catch (error) {
    const created =
      ctx.store === store
        ? store.conversations.find((row) => row.id === childId)
        : undefined;
    if (created)
      return {
        session_id: `local_${childId}`,
        title: created.title,
        notice:
          "The start did not finish normally. Check this session before retrying.",
        failed: true,
      };
    throw error;
  } finally {
    pending.delete(parent.id);
  }
}
