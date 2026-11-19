import { randomBytes, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { localGit } from "../git/code-worktree";
import { z } from "zod";
import type { AppContext } from "../app/app-context";
import { BrowserMcpServer, type McpTool } from "../browser/mcp-server";
import { inAdapterScope, newAdapterScope } from "../official-ui/api/scope";
import { readState } from "../official-ui/api/state";
import type { Conversation } from "../../shared/types";
import { codeEffortLevels, effortForMode } from "../../shared/code-effort";
import { preference } from "../../shared/settings-extras";
import { requestCodeHelperCloud } from "./code-helper-cloud";
import { applyCodeHelperPreset, codeHelperPermission, codeHelperPermissionInput, codeHelperStartTargets, codeModelProposalSession } from "./code-helper-targets";
import { codeModelProposalBrief, codeModelProposalId } from "../../shared/official-code-model-proposal";
import { actOnCodeModelProposal, recordCodeModelProposal, waitForModelOffer } from "./code-model-proposals";
import { startCodeHelperSsh } from "./code-helper-ssh";

const startProperties = {
  initiation: {
    type: "string",
    enum: ["user_asked", "own_initiative", "offer"],
  },
  proposal_id: { type: "string" },
  title: { type: "string" },
  prompt: { type: "string" },
  context: { type: "string", enum: ["fresh", "fork"] },
  background: { type: "string" },
  wake_when_done: { type: "boolean" },
  name: { type: "string" },
  use_worktree: { type: "boolean" },
  model: { type: "string" },
  target: { type: "string", enum: ["local", "cloud", "ssh"] },
  host: { type: "string" },
  cwd: { type: "string" },
  environment: { type: "string" },
  repository: { type: "string" },
  source_branch: { type: "string" },
  branch_name: { type: "string" },
  preset: { type: "string" },
  effort: {
    type: "string",
    enum: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  permission_mode: {
    type: "string",
    enum: ["default", "acceptEdits", "plan", "auto", "bypassPermissions"],
  },
};
const startTool: McpTool = {
  name: "start_session",
  description:
    "Start a Code session when explicitly requested (user_asked), propose one without starting it (own_initiative), or wait for the user to choose (offer). Use list_start_targets for a named folder, SSH connection or cloud environment. After an offer is accepted, call with proposal_id, prompt, and background. Fresh briefs require background. Forks inherit the current conversation.",
  inputSchema: { type: "object", properties: startProperties, required: [] },
};
const listTool: McpTool = {
  name: "list_sessions",
  description:
    "List the user's other Code sessions, most recently active first. The current session is excluded.",
  inputSchema: {
    type: "object",
    properties: {
      include_archived: { type: "boolean" },
      limit: { type: "number" },
      group: { type: "string" },
      linked: { type: "boolean" },
    },
  },
};
const dismissTool: McpTool = {
  name: "dismiss_task",
  description: "Withdraw one of this Code session's pending task proposals.",
  inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] },
};
const targetsTool: McpTool = {
  name: "list_start_targets",
  description: "List the current Code project, saved SSH connections, cloud environments and session presets available to this account.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};
const cloudInput = z.object({
  initiation: z.literal("user_asked"),
  title: z.string().trim().min(1).max(59),
  prompt: z.string().trim().min(1).max(32_000),
  background: z.string().trim().min(80).max(32_000),
  context: z.literal("fresh").optional(),
  target: z.literal("cloud"),
  environment: z.string().trim().min(1).max(200).optional(),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/).max(210).optional(),
});
const proposalInput = z.strictObject({
  initiation: z.enum(["own_initiative", "offer"]),
  title: z.string().trim().min(1).max(59),
  prompt: z.string().trim().min(1).max(32_000).optional(),
  background: z.string().trim().max(32_000).optional(),
  context: z.enum(["fresh", "fork"]).optional(),
  target: z.literal("local").optional(),
  use_worktree: z.boolean().optional(),
  model: z.string().trim().min(1).max(200).optional(),
  effort: z.enum(codeEffortLevels).optional(),
});
const fillInput = z.strictObject({
  proposal_id: codeModelProposalId,
  initiation: z.literal("user_asked").optional(),
  prompt: z.string().trim().min(1).max(32_000),
  background: z.string().trim().min(80).max(32_000),
  wake_when_done: z.boolean().optional(),
});
const startProposalInput = z.strictObject({
  proposal_id: codeModelProposalId,
  initiation: z.literal("user_asked").optional(),
  wake_when_done: z.boolean().optional(),
});
const startInput = z
  .object({
    initiation: z.literal("user_asked"),
    title: z.string().trim().min(1).max(59),
    prompt: z.string().trim().min(1).max(200000),
    background: z.string().trim().max(200000).optional(),
    context: z.enum(["fresh", "fork"]).optional(),
    target: z.literal("local").optional(),
    use_worktree: z.boolean().optional(),
    wake_when_done: z.boolean().optional(),
    permission_mode: codeHelperPermissionInput.optional(),
    cwd: z.string().min(1).max(4096).optional(),
    source_branch: z.string().min(1).max(255).optional(),
    branch_name: z.string().min(1).max(255).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    effort: z
      .enum(["low", "medium", "high", "xhigh", "max", "ultra"])
      .optional(),
  })
  .strict();
const listInput = z
  .object({
    include_archived: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    linked: z.boolean().optional(),
  })
  .strict();
const response = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  ...(isError ? { isError: true } : {}),
});
const publicId = (id: string) => `local_${id}`;

/** Account-owned MCP transports for local Code sessions. */
export function registerCodeSessionHelpers(ctx: AppContext) {
  let dispose: (() => void) | undefined;
  ctx.onAccountActivated(() => {
    dispose?.();
    const owner = ctx.activeAccount?.id,
      identity = ctx.accountActivationIdentity;
    const store = ctx.store,
      engine = ctx.engine;
    if (!owner || identity === undefined) return;
    const scope = newAdapterScope(owner, store.root, identity);
    const alive = () =>
      !ctx.accountRetiring &&
      ctx.activeAccount?.id === owner &&
      ctx.accountActivationIdentity === identity &&
      ctx.store === store &&
      ctx.engine === engine;
    const enabled = () => {
      if (!alive()) return false;
      const prefs = inAdapterScope(scope, () =>
        readState<Record<string, unknown> | null>("preferences", {}),
      );
      const value = prefs?.epitaxyPrefs;
      return !(
        value &&
        typeof value === "object" &&
        "sessionHelpers" in value &&
        value.sessionHelpers === false
      );
    };
    const accessible = (c: Conversation | undefined) =>
      !!c &&
      c.mode === "code" &&
      !c.incognito &&
      !c.cloudHosted &&
      !c.cloudEnvironmentId &&
      !c.linkedToComputer &&
      !c.chatDeviceBinding &&
      !c.remoteCodeWorktree &&
      !c.remoteControlStarted &&
      (c.environment?.kind ?? "local") === "local" &&
      !c.projectOrganizationId &&
      (!c.sessionAuthors ||
        (c.sessionAuthors.ownerAccountUuid === owner &&
          c.sessionAuthors.viewerAccountUuid === owner));
    const eligible = (c: Conversation | undefined) =>
      accessible(c) && !c?.archived;
    const get = (id: string) => store.conversations.find((c) => c.id === id);
    const accessibleLinkedSsh = (c: Conversation) =>
      c.mode === "code" && c.environment?.kind === "ssh" && !c.incognito && !c.cloudHosted &&
      !c.cloudEnvironmentId && !c.linkedToComputer && !c.chatDeviceBinding && !c.remoteControlStarted &&
      !c.projectOrganizationId && !!c.nativeSideSession && !!c.codeHelperParentTurnId && !!c.parentSessionId &&
      accessible(get(c.parentSessionId)) && (!c.sessionAuthors ||
        (c.sessionAuthors.ownerAccountUuid === owner && c.sessionAuthors.viewerAccountUuid === owner));
    const pending = new Set<string>();
    const removers: (() => void)[] = [];
    const servers: { server: BrowserMcpServer; ready: Promise<void> }[] = [];
    for (const [name, tool] of [
      ["ccd_session", startTool],
      ["ccd_session_mgmt", listTool],
    ] as const) {
      const declared = name === "ccd_session" ? [tool, dismissTool, targetsTool] : [tool];
      const token = randomBytes(32).toString("base64url");
      const server = new BrowserMcpServer({
        token,
        serverName: name,
        handlers: {
          tools(id) {
            return enabled() && eligible(get(id)) ? declared : [];
          },
          async call(called, args, call) {
            try {
              const parent = get(call.conversationId);
              const turn = parent?.turns.at(-1);
              const meta = z
                .object({ threadId: z.string(), turnId: z.string().optional() })
                .passthrough()
                .safeParse(call.meta);
              const current = () =>
                enabled() &&
                eligible(parent) &&
                get(call.conversationId) === parent &&
                !!parent &&
                !!turn &&
                parent.turns.at(-1) === turn &&
                turn.status === "inProgress" &&
                parent.threadId ===
                  (meta.success ? meta.data.threadId : undefined) &&
                (!meta.success ||
                  meta.data.turnId === undefined ||
                  meta.data.turnId === turn.id) &&
                !call.signal.aborted;
              if (!current() || !parent || !turn || !declared.some(candidate => candidate.name === called))
                return response(
                  "This Code session is no longer available.",
                  true,
                );
              if (name === "ccd_session_mgmt") {
                const parsed = listInput.safeParse(args);
                if (!parsed.success)
                  return response("Unsupported or invalid list options.", true);
                const family = new Set([parent.id]);
                let changed = true;
                while (changed) {
                  changed = false;
                  for (const c of store.conversations)
                    if (
                      c.parentSessionId &&
                      (family.has(c.parentSessionId) || family.has(c.id))
                    ) {
                      for (const id of [c.id, c.parentSessionId])
                        if (!family.has(id)) {
                          family.add(id);
                          changed = true;
                        }
                    }
                }
                const rows = store.conversations
                  .filter(
                    (c) =>
                      c.id !== parent.id &&
                      c.mode === "code" &&
                      (accessible(c) || accessibleLinkedSsh(c)) &&
                      (parsed.data.include_archived || !c.archived) &&
                      (!parsed.data.linked || family.has(c.id)),
                  )
                  .map((c) => ({
                    sessionId: publicId(c.id),
                    title: c.title,
                    cwd: c.cwd,
                    archived: c.archived,
                    updatedAt: c.updatedAt,
                    ...(c.parentSessionId
                      ? { startedBy: publicId(c.parentSessionId) }
                      : {}),
                  }));
                const cloud = store.conversations.flatMap(c => accessible(c) &&
                  (parsed.data.include_archived || !c.archived) && (!parsed.data.linked || family.has(c.id))
                  ? (c.cloudSpawnedTasks ?? []).map(child => ({
                    sessionId: child.sessionId, title: child.title, target: "cloud", startedBy: publicId(c.id),
                    updatedAt: c.codeCloudHelperStarts?.find(start => start.taskId === child.taskId)?.createdAt ?? c.updatedAt,
                  })) : []);
                return response(JSON.stringify([...rows, ...cloud].sort((a, b) => b.updatedAt - a.updatedAt)
                  .slice(0, parsed.data.limit ?? 20)));
              }
              if (called === dismissTool.name) {
                const { task_id } = z.strictObject({ task_id: codeModelProposalId }).parse(args);
                const dismissed = await actOnCodeModelProposal(ctx, parent.id, task_id, { kind: "pop", launched: false }, current);
                return response(dismissed ? `Dismissed ${task_id}.` : "That proposal is no longer pending.", !dismissed);
              }
              if (called === targetsTool.name) {
                if (Object.keys(args).length) return response("This tool does not take arguments.", true);
                const targets = await codeHelperStartTargets(ctx, parent, scope,
                  row => accessible(row) || accessibleLinkedSsh(row));
                return current() ? response(JSON.stringify(targets)) : response("This Code session changed.", true);
              }
              if (turn.codeHelperWake && parent.nativeSideSession)
                return response("A linked session cannot start another session while waking for a result.", true);
              if (args.preset !== undefined) args = applyCodeHelperPreset(ctx, scope, args);
              if (args.proposal_id !== undefined) {
                const proposal = startProposalInput.safeParse(args);
                if (proposal.success && !turn.autoContinuation) {
                  const result = await actOnCodeModelProposal(ctx, parent.id, proposal.data.proposal_id,
                    { kind: "start", wakeWhenDone: proposal.data.wake_when_done }, current);
                  return typeof result === "object" && "sessionId" in result ? response(JSON.stringify({ session_id: result.sessionId })) :
                    response("That suggested task is no longer available to start.", true);
                }
                const fill = fillInput.parse(args);
                if (fill.prompt.length + fill.background.length > 31_900)
                  return response("The proposed brief is too long.", true);
                const result = await actOnCodeModelProposal(ctx, parent.id, fill.proposal_id,
                  { kind: "fill", prompt: fill.prompt, background: fill.background, wakeWhenDone: fill.wake_when_done }, current);
                if (typeof result !== "object") return response("No accepted offer in this Code session is waiting for this brief.", true);
                return response(JSON.stringify("taskId" in result ? { task_id: result.taskId, status: "requested" } :
                  { session_id: result.sessionId }));
              }
              if (args.initiation === "own_initiative" || args.initiation === "offer") {
                if (!codeModelProposalSession(parent, owner) || !parent.cwd)
                  return response("This Code session cannot propose a local task.", true);
                const input = proposalInput.parse(args);
                const offer = input.initiation === "offer";
                const offerPreference = preference(store.settings, "ccNewTaskPrompt");
                if (offer && (offerPreference === "here" || turn.autoContinuation))
                  return response("Continue this task in the current Code session.");
                const context = input.context ?? "fresh";
                if (context === "fork" && (offer || input.use_worktree !== undefined || input.model || input.effort))
                  return response("Proposed forks inherit the parent checkout and model settings. Offers start with fresh context.", true);
                if (!offer && (!input.prompt || context === "fresh" && (input.background?.length ?? 0) < 80))
                  return response("Provide a prompt and at least 80 characters of background for a fresh suggestion.", true);
                const provider = store.settings.providers.find(row => row.id === parent.providerId);
                const baseEffort = parent.effort ?? store.projects.find(row => row.id === parent.projectId)?.defaultEffort ?? effortForMode(store.settings, "code");
                if (!provider || input.model && ![provider.model, parent.model, ...provider.models].includes(input.model) ||
                    input.effort && codeEffortLevels.indexOf(input.effort) > codeEffortLevels.indexOf(baseEffort))
                  return response("The proposal's model or effort is unavailable for this session.", true);
                ctx.allowedFolder(parent.cwd, parent.environment);
                const brief = input.prompt ? codeModelProposalBrief(context, input.prompt, input.background) : "";
                if (brief.length > 32_000) return response("The proposed brief is too long.", true);
                const offerCalls = offer ? turn.items.filter(item => item.type === "mcpToolCall" &&
                  item.server === "ccd_session" && item.tool === called && item.status === "inProgress") : [];
                if (offer && offerCalls.length !== 1)
                  return response("The Code offer's active tool call could not be identified.", true);
                const proposal = recordCodeModelProposal(ctx, { parent, current }, {
                  kind: offer ? "offer" : "suggestion", title: input.title, brief, context,
                  sourceTurnId: turn.id, sourceCwd: parent.cwd, providerId: parent.providerId,
                  ...(offerCalls[0] ? { sourceToolCallId: offerCalls[0].id } : {}),
                  worktree: input.use_worktree, model: input.model, effort: input.effort,
                });
                if (!offer) return response(JSON.stringify({ proposal_id: proposal.id, expires_at: proposal.expiresAt }));
                const decision = waitForModelOffer(store, parent.id, proposal.id, call.signal);
                if (offerPreference === "new_session" && (parent.codeModelProposals ?? []).filter(row =>
                    row.sourceTurnId === turn.id && row.state.kind !== "pending" && row.state.kind !== "dismissed").length < 10) {
                  await actOnCodeModelProposal(ctx, parent.id, proposal.id,
                    { kind: "acceptOffer", selection: { target: "local", auto: true } }, current);
                }
                const accepted = await decision;
                if (call.signal.aborted && alive())
                  await actOnCodeModelProposal(ctx, parent.id, proposal.id, { kind: "pop", launched: false }, alive);
                if (!current()) return response("The offer ended with the parent turn.", true);
                return response(accepted ?
                  `The user chose New session for ${proposal.id}. Call start_session with proposal_id "${proposal.id}", prompt, and a background of at least 80 characters.` :
                  `The user did not start ${proposal.id}. Continue in this session.`);
              }
              if (args.target === "ssh") {
                const result = await startCodeHelperSsh(ctx, parent, turn, args, call, current, pending);
                return response(JSON.stringify(result), result.failed === true);
              }
              if (args.target === "cloud") {
                const input = cloudInput.parse(args);
                const brief = codeModelProposalBrief("fresh", input.prompt, input.background);
                if (brief.length > 32_000) return response("The proposed brief is too long.", true);
                const calls = turn.items.filter(item => item.type === "mcpToolCall" && item.server === "ccd_session" &&
                  item.tool === called && item.status === "inProgress");
                if (calls.length !== 1 || !parent.threadId)
                  return response("The active cloud tool call could not be identified.", true);
                const result = await requestCodeHelperCloud(ctx, parent, {
                  title: input.title, brief, environment: input.environment, repository: input.repository,
                  threadId: parent.threadId, turnId: turn.id, toolCallId: calls[0].id, signal: call.signal,
                }, current);
                return response(JSON.stringify({ task_id: result.taskId, status: "requested" }));
              }
              const parsed = startInput.safeParse(args);
              if (!parsed.success)
                return response(
                  "Provide an explicitly requested local session with a title and prompt. Fresh sessions also need at least 80 characters of background.",
                  true,
                );
              if (
                parsed.data.context !== "fork" &&
                (parsed.data.background?.length ?? 0) < 80
              )
                return response(
                  "Fresh sessions need at least 80 characters of background.",
                  true,
                );
              if (!parent.cwd)
                return response(
                  "This session has no current folder. Nothing started.",
                  true,
                );
              const folder = parent.cwd;
              if (parsed.data.context === "fork") {
                if (
                  parsed.data.cwd ||
                  parsed.data.source_branch ||
                  parsed.data.branch_name ||
                  parsed.data.model ||
                  parsed.data.effort ||
                  parsed.data.use_worktree === false ||
                  (parsed.data.use_worktree === true && !parent.worktree)
                )
                  return response(
                    "Forks inherit the current folder, model and effort. Worktree overrides are unavailable.",
                    true,
                  );
                const calls = turn.items.filter(
                  (item) =>
                    item.type === "mcpToolCall" &&
                    item.server === "ccd_session" &&
                    item.tool === "start_session" &&
                    item.status === "inProgress",
                );
                if (calls.length !== 1 || !parent.threadId)
                  return response(
                    "The current fork boundary is unavailable. Nothing started.",
                    true,
                  );
                const forkCurrent = () => {
                  if (!current() || parent.cwd !== folder) return false;
                  try {
                    ctx.allowedFolder(folder, parent.environment);
                    return true;
                  } catch {
                    return false;
                  }
                };
                if (!forkCurrent())
                  return response(
                    "The current folder is unavailable. Nothing started.",
                    true,
                  );
                if (pending.has(parent.id))
                  return response(
                    "A session start is already in progress. Check its result before retrying.",
                    true,
                  );
                pending.add(parent.id);
                const childId = randomUUID();
                try {
                  const child = await engine.forkConversation(
                    parent.id,
                    turn.id,
                    undefined,
                    undefined,
                    forkCurrent,
                    {
                      conversationId: childId,
                      before: { turnId: turn.id, itemId: calls[0].id },
                      ...(parent.worktree ? { separateWorktree: true as const } : {}),
                    },
                  );
                  if (!forkCurrent())
                    throw Error(
                      "The parent session changed. Check the new session before retrying.",
                    );
                  const saved = get(child.id);
                  if (!saved)
                    throw Error(
                      "The fork could not be confirmed. Check before retrying.",
                    );
                  store.commitLocalCodeHistory(saved, { title: parsed.data.title, titleSetByUser: true,
                    nativeSideSession: { taskId: `task_${randomBytes(4).toString("hex")}` }, codeHelperParentTurnId: turn.id,
                    ...(parsed.data.wake_when_done ? { codeHelperWakeWhenDone: true } : {}) }, undefined, forkCurrent);
                  engine.changed(saved, true);
                  await engine.send(
                    {
                      conversationId: child.id,
                      text: [parsed.data.background, parsed.data.prompt]
                        .filter(Boolean)
                        .join("\n\n"),
                      attachments: [],
                      mode: "code",
                      cwd: child.cwd,
                      projectId: child.projectId,
                      providerId: child.providerId,
                      model: child.model,
                    },
                    undefined,
                    false,
                    {
                      current: forkCurrent,
                      interactive: false,
                      newTaskResolved: true,
                    },
                  );
                  if (saved.turns.at(-1)?.status === "failed")
                    return response(
                      JSON.stringify({
                        session_id: publicId(child.id),
                        title: saved.title,
                        notice:
                          "The session could not start. Check it before retrying.",
                      }),
                      true,
                    );
                  return response(
                    JSON.stringify({
                      session_id: publicId(child.id),
                      title: saved.title,
                      notice: "The child can post its result to this session.",
                    }),
                  );
                } catch (error) {
                  const created = alive() ? get(childId) : undefined;
                  if (created)
                    return response(
                      JSON.stringify({
                        session_id: publicId(childId),
                        title: created.title,
                        notice:
                          "The start did not finish normally. Check this session before retrying.",
                      }),
                      true,
                    );
                  throw error;
                } finally {
                  pending.delete(parent.id);
                }
              }
              const providerId = parent.providerId;
              const parentModel = parent.model;
              const parentEffort = parent.effort;
              const parentTree = parent.worktree;
              const parentParent = parent.parentSessionId;
              const rawPermission =
                turn?.codePermissionMode ?? parent.codePermissionMode;
              const permission = codeHelperPermission(store.settings, parent, parsed.data.permission_mode);
              const startCurrent = () =>
                current() &&
                parent.cwd === folder &&
                parent.providerId === providerId &&
                parent.model === parentModel &&
                parent.effort === parentEffort &&
                parent.worktree === parentTree &&
                parent.parentSessionId === parentParent &&
                (turn?.codePermissionMode ?? parent.codePermissionMode) ===
                  rawPermission;
              ctx.allowedFolder(folder, parent.environment);
              let destination = folder;
              let placementIdentity: { real: string; dev: number; ino: number } | undefined;
              if (parsed.data.cwd) {
                const requested =
                  parsed.data.cwd === "~"
                    ? os.homedir()
                    : parsed.data.cwd.startsWith("~/")
                      ? path.join(os.homedir(), parsed.data.cwd.slice(2))
                      : parsed.data.cwd;
                if (!path.isAbsolute(requested))
                  return response(
                    "cwd must be an absolute local folder path.",
                    true,
                  );
                const [actual, chosen] = await Promise.all([
                  fs.realpath(folder),
                  fs.realpath(requested),
                ]);
                if (!startCurrent())
                  return response(
                    "This Code session changed. Nothing started.",
                    true,
                  );
                if (actual !== chosen) {
                  ctx.allowedFolder(requested, parent.environment);
                  const info = await fs.stat(chosen);
                  if (!info.isDirectory()) return response("Choose a local working folder.", true);
                  destination = requested;
                  placementIdentity = { real: chosen, dev: info.dev, ino: info.ino };
                }
              }
              let ancestor: Conversation | undefined = destination === folder ? parent : undefined;
              const seen = new Set<string>();
              let sharedWorktree: Conversation["worktree"];
              while (ancestor && !seen.has(ancestor.id)) {
                seen.add(ancestor.id);
                if (ancestor.worktree && ancestor.cwd === folder) {
                  sharedWorktree = ancestor.worktree;
                  break;
                }
                ancestor = ancestor.parentSessionId
                  ? get(ancestor.parentSessionId)
                  : undefined;
              }
              const worktree = parsed.data.use_worktree ?? !!sharedWorktree;
              const worktreeFolder =
                worktree && sharedWorktree ? sharedWorktree.origin : destination;
              if (worktreeFolder !== folder)
                ctx.allowedFolder(worktreeFolder, parent.environment);
              if (
                !worktree &&
                (parsed.data.source_branch || parsed.data.branch_name)
              )
                return response(
                  "source_branch and branch_name require a separate worktree.",
                  true,
                );
              const provider = store.settings.providers.find(
                (p) => p.id === providerId,
              );
              if (!provider)
                return response("The model service is unavailable.", true);
              const model = parsed.data.model ?? parentModel;
              if (
                ![provider.model, ...provider.models, parentModel].includes(
                  model,
                )
              )
                return response("This account can't use this model.", true);
              const currentEffort =
                parentEffort ??
                store.projects.find((p) => p.id === parent.projectId)
                  ?.defaultEffort ??
                effortForMode(store.settings, "code");
              if (
                parsed.data.effort &&
                codeEffortLevels.indexOf(parsed.data.effort) >
                  codeEffortLevels.indexOf(currentEffort)
              )
                return response(
                  "The new session's effort cannot exceed this session's effort.",
                  true,
                );
              const capturedSource = sharedWorktree?.sourceBranch;
              const capturedOrigin = sharedWorktree?.origin;
              const fenced = () => {
                if (
                  !startCurrent() ||
                  (sharedWorktree &&
                    (ancestor?.worktree !== sharedWorktree ||
                      sharedWorktree.origin !== capturedOrigin ||
                      sharedWorktree.sourceBranch !== capturedSource)) ||
                  store.settings.providers.find((p) => p.id === providerId) !==
                    provider ||
                  ![provider.model, ...provider.models, parentModel].includes(
                    model,
                  )
                )
                  return false;
                try {
                  ctx.allowedFolder(folder, parent.environment);
                  if (codeHelperPermission(store.settings, parent, parsed.data.permission_mode) !== permission)
                    return false;
                  if (worktreeFolder !== folder)
                    ctx.allowedFolder(worktreeFolder, parent.environment);
                  if (placementIdentity) {
                    const info = statSync(destination);
                    if (realpathSync(destination) !== placementIdentity.real || info.dev !== placementIdentity.dev ||
                        info.ino !== placementIdentity.ino || !info.isDirectory()) return false;
                  }
                  return true;
                } catch {
                  return false;
                }
              };
              let sourceBranch = worktree
                ? sharedWorktree?.sourceBranch
                : undefined;
              if (parsed.data.source_branch) {
                const branch = parsed.data.source_branch;
                if (
                  branch.startsWith("-") ||
                  branch.startsWith("refs/") ||
                  branch.trim() !== branch
                )
                  return response(
                    "source_branch must name an existing local branch.",
                    true,
                  );
                try {
                  await localGit(
                    destination,
                    ["check-ref-format", `refs/heads/${branch}`],
                    5000,
                    call.signal,
                  );
                  sourceBranch = (
                    await localGit(
                      destination,
                      [
                        "rev-parse",
                        "--verify",
                        `refs/heads/${branch}^{commit}`,
                      ],
                      5000,
                      call.signal,
                    )
                  ).trim();
                  if (!/^[0-9a-f]{40,64}$/i.test(sourceBranch))
                    throw Error("Invalid branch commit.");
                } catch {
                  return response(
                    "source_branch must name an existing local branch.",
                    true,
                  );
                }
              }
              if (!fenced())
                return response(
                  "This Code session changed. Nothing started.",
                  true,
                );
              if (pending.has(parent.id))
                return response(
                  "A session start is already in progress. Check its result before retrying.",
                  true,
                );
              pending.add(parent.id);
              const childId = randomUUID();
              try {
                if (destination !== folder) {
                  const answer = await engine.requestAppApproval(parent.id, {
                    threadId: parent.threadId, turnId: turn.id, serverName: "ccd_session", mode: "form",
                    message: `Allow starting a Code session in ${JSON.stringify(destination)}?`,
                    requestedSchema: { type: "object", properties: {
                      decision: { type: "string", enum: ["once"], enumNames: ["Allow"] },
                    }, required: ["decision"] },
                  }, call.signal);
                  if (answer?.action !== "accept" || !fenced())
                    return response("The selected folder was not approved or changed. Nothing started.", true);
                }
                const child = await engine.send(
                  {
                    text: `${parsed.data.background}\n\n${parsed.data.prompt}`,
                    attachments: [],
                    mode: "code",
                    parentSessionId: parent.id,
                    codeHelperLink: { taskId: `task_${randomBytes(4).toString("hex")}`, title: parsed.data.title,
                      parentTurnId: turn.id, wakeWhenDone: parsed.data.wake_when_done },
                    cwd: worktreeFolder,
                    projectId: destination === folder ? parent.projectId : undefined,
                    providerId,
                    model,
                    effort: parsed.data.effort ?? parentEffort,
                    codePermissionMode: permission,
                    worktree,
                    worktreeBranch: sourceBranch,
                    worktreeBranchHint: parsed.data.branch_name,
                    newConversationId: childId,
                  },
                  undefined,
                  false,
                  {
                    current: fenced,
                    interactive: false,
                    newTaskResolved: true,
                  },
                );
                if (!alive())
                  throw Error(
                    "The account changed. Check the session before retrying.",
                  );
                const saved = get(child.id);
                if (saved?.turns.at(-1)?.status === "failed")
                  return response(
                    JSON.stringify({
                      session_id: publicId(child.id),
                      title: saved.title,
                      notice:
                        "The session could not start. Check it before retrying.",
                    }),
                    true,
                  );
                if (current() && saved) {
                  saved.title = parsed.data.title;
                  engine.changed(saved, true);
                  store.flush();
                }
                return response(
                  JSON.stringify({
                    session_id: publicId(child.id),
                    title: saved?.title ?? child.title,
                    notice: "The child can post its result to this session.",
                  }),
                );
              } catch (error) {
                const created = alive() ? get(childId) : undefined;
                if (created)
                  return response(
                    JSON.stringify({
                      session_id: publicId(childId),
                      title: created.title,
                      notice:
                        "The start did not finish normally. Check this session before retrying.",
                    }),
                    true,
                  );
                throw error;
              } finally {
                pending.delete(parent.id);
              }
            } catch (error) {
              return response(
                error instanceof Error
                  ? error.message
                  : "The session helper failed.",
                true,
              );
            }
          },
        },
      });
      const ready = server.start().catch((error) => {
        console.error("Code session helper could not start:", error);
      });
      servers.push({ server, ready });
      removers.push(
        engine.extensions.add({
          id: `code-session-helper-${name}`,
          reservedMcpServerNames: [name],
          loopbackMcpBridge: { name, ready, port: () => server.port },
          builtinMcpServers: ({ conversation }) => {
            if (!enabled() || !eligible(get(conversation.id))) return;
            const url = server.url(conversation.id);
            return url
              ? [
                  {
                    name,
                    url,
                    enabled: true,
                    httpHeaders: { Authorization: `Bearer ${token}` },
                    defaultToolsApprovalMode: "approve",
                  },
                ]
              : undefined;
          },
        }),
      );
    }
    dispose = () => {
      for (const remove of removers) remove();
      for (const { server, ready } of servers)
        void ready.then(() => server.close());
    };
  });
  ctx.onAccountDeactivating(() => {
    dispose?.();
    dispose = undefined;
  });
}
