import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AppContext } from "../app/app-context";
import { workspaceRepository } from "../git/git-branch";
import {
  codeCloudSideSessionId,
  codeCloudSideSessionTarget,
  type CodeCloudSideSessionTarget,
  type CodeCloudHelperStart,
} from "../../shared/official-code-side-session";
import type { Conversation } from "../../shared/types";
import { codeModelProposalSession } from "./code-helper-targets";

const operations = new WeakMap<object, Set<string>>();
const uncertainReservations = new WeakMap<object, Set<string>>();

const environmentHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const approvalLabel = (value: string) =>
  value.replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    "",
  );

type CloudInput = {
  title: string;
  brief: string;
  environment?: string;
  repository?: string;
  threadId: string;
  turnId: string;
  toolCallId: string;
  signal?: AbortSignal;
};

function activation(ctx: AppContext, parent: Conversation) {
  const store = ctx.store,
    engine = ctx.engine,
    owner = ctx.activeAccount?.id;
  const identity = ctx.accountActivationIdentity;
  return () =>
    !!owner &&
    identity !== undefined &&
    !ctx.accountRetiring &&
    ctx.activeAccount?.id === owner &&
    ctx.accountActivationIdentity === identity &&
    ctx.store === store &&
    ctx.engine === engine &&
    store.conversations.includes(parent) &&
    codeModelProposalSession(parent, owner);
}

function save(
  ctx: AppContext,
  parent: Conversation,
  rows: CodeCloudHelperStart[],
  current: () => boolean,
  links = parent.cloudSpawnedTasks,
) {
  ctx.store.commitLocalCodeHistory(
    parent,
    { codeCloudHelperStarts: rows, cloudSpawnedTasks: links },
    undefined,
    current,
  );
  ctx.engine.changed(parent, true);
}

async function dispatch(
  ctx: AppContext,
  parent: Conversation,
  start: CodeCloudHelperStart,
  current: () => boolean,
) {
  const store = ctx.store;
  const running = operations.get(store) ?? new Set<string>();
  operations.set(store, running);
  const key = `${parent.id}:${start.taskId}`;
  if (running.has(key) || !current()) return;
  const cloud = ctx.officialCodeHelperCloud?.();
  if (!cloud?.available()) return;
  running.add(key);
  try {
    const environments = await cloud.listCloudEnvironments();
    const environment = environments.find(
      (row) => row.id === start.target.environmentId,
    );
    if (
      !current() ||
      !environment ||
      environment.updatedAt !== start.environmentUpdatedAt ||
      environmentHash(environment) !== start.environmentHash
    )
      return;
    const sessionId = codeCloudSideSessionId.parse(
      await cloud.startSideSession({
        target: start.target,
        requestId: start.requestId,
        parentId: parent.id,
        taskId: start.taskId,
        text: start.brief,
      }),
    );
    if (!current()) return;
    const rows = parent.codeCloudHelperStarts ?? [];
    const saved = rows.find((row) => row.taskId === start.taskId);
    if (!saved || saved.state !== "pending" || !isDeepStrictEqual(saved, start))
      return;
    const links = parent.cloudSpawnedTasks ?? [];
    const existing = links.find((row) => row.taskId === start.taskId);
    if (
      existing &&
      (existing.sessionId !== sessionId ||
        existing.messageUuid !== start.requestId)
    )
      throw Error("The cloud session link conflicts with its saved request.");
    save(
      ctx,
      parent,
      rows.map((row) =>
        row === saved ? { ...saved, state: "started", sessionId } : row,
      ),
      current,
      existing
        ? links
        : [
            ...links,
            {
              taskId: start.taskId,
              sessionId,
              title: start.title,
              messageUuid: start.requestId,
            },
          ],
    );
  } catch {
    // A failed response may still have created the remote session. Retain the same request for recovery.
  } finally {
    running.delete(key);
  }
}

export async function prepareCodeCloudOffer(
  ctx: AppContext,
  parent: Conversation,
  proposal: import("../../shared/official-code-model-proposal").CodeModelProposal,
  selection: Extract<
    import("zod").infer<
      typeof import("../../shared/official-code-side-session").officialCodeSideSessionTarget
    >,
    { target: "cloud" }
  >,
  current: () => boolean,
) {
  const cloud = ctx.officialCodeHelperCloud?.();
  if (
    !cloud?.available() ||
    !current() ||
    !parent.cwd ||
    parent.cwd !== proposal.sourceCwd ||
    parent.providerId !== proposal.providerId ||
    selection.auto ||
    selection.poolId
  )
    throw Error("This cloud environment is not available.");
  const cwd = parent.cwd,
    model = parent.model,
    providerId = parent.providerId;
  ctx.allowedFolder(cwd, parent.environment);
  const repository = workspaceRepository(cwd);
  if (!repository)
    throw Error("A GitHub repository is required for Cloud Code.");
  const environments = await cloud.listCloudEnvironments();
  const selected = environments.find(
    (row) => row.id === (selection.environmentId ?? "default"),
  );
  if (
    !current() ||
    parent.cwd !== cwd ||
    parent.model !== model ||
    parent.providerId !== providerId ||
    workspaceRepository(cwd) !== repository ||
    !selected
  )
    throw Error("The cloud placement changed. Nothing started.");
  const provider = ctx.store.settings.providers.find(
    (row) => row.id === providerId,
  );
  const chosenModel =
    selection.picks?.model === "default"
      ? provider?.model
      : (selection.picks?.model ?? model);
  if (
    !provider ||
    !chosenModel ||
    ![provider.model, model, ...provider.models].includes(chosenModel)
  )
    throw Error("The selected Code model is unavailable.");
  const target = codeCloudSideSessionTarget.parse({
    environmentId: selected.id,
    repository,
    model: chosenModel,
    ...(selection.picks?.effort ? { effort: selection.picks.effort } : {}),
    permissionMode: selection.picks?.permissionMode ?? "default",
  });
  return {
    kind: "cloudAccepted" as const,
    requestId: randomUUID(),
    target,
    environmentUpdatedAt: selected.updatedAt,
    environmentHash: environmentHash(selected),
    briefFilled: false,
  };
}

export function fillCodeCloudOffer(
  ctx: AppContext,
  parent: Conversation,
  proposal: import("../../shared/official-code-model-proposal").CodeModelProposal,
  claim: Extract<
    import("../../shared/official-code-model-proposal").CodeModelProposal["state"],
    { kind: "cloudAccepted" }
  >,
  brief: string,
  current: () => boolean,
) {
  const alive = activation(ctx, parent);
  if (
    !current() ||
    !alive() ||
    !parent.codeModelProposals?.includes(proposal) ||
    !parent.threadId ||
    !proposal.sourceToolCallId
  )
    throw Error("This cloud offer is no longer available.");
  const prior = parent.codeCloudHelperStarts?.find(
    (row) => row.taskId === proposal.id,
  );
  if (prior) {
    if (prior.requestId !== claim.requestId || prior.brief !== brief)
      throw Error("This cloud offer already has a different brief.");
    if (prior.state === "pending") void dispatch(ctx, parent, prior, alive);
    return { taskId: proposal.id };
  }
  if (claim.briefFilled || !brief.trim() || brief.length > 32000)
    throw Error("This cloud offer cannot accept that brief.");
  const start: CodeCloudHelperStart = {
    taskId: proposal.id,
    requestId: claim.requestId,
    toolCallId: proposal.sourceToolCallId,
    threadId: parent.threadId,
    turnId: proposal.sourceTurnId,
    title: proposal.title,
    brief,
    target: claim.target,
    environmentUpdatedAt: claim.environmentUpdatedAt,
    environmentHash: claim.environmentHash,
    createdAt: Date.now(),
    state: "pending",
  };
  ctx.store.commitLocalCodeHistory(
    parent,
    {
      codeModelProposals: parent.codeModelProposals.map((row) =>
        row === proposal
          ? { ...row, brief, state: { ...claim, briefFilled: true } }
          : row,
      ),
      codeCloudHelperStarts: [...(parent.codeCloudHelperStarts ?? []), start],
    },
    undefined,
    current,
  );
  ctx.engine.changed(parent, true);
  void dispatch(ctx, parent, start, alive);
  return { taskId: proposal.id };
}

export async function requestCodeHelperCloud(
  ctx: AppContext,
  parent: Conversation,
  input: CloudInput,
  current: () => boolean,
): Promise<{ taskId: string }> {
  const alive = activation(ctx, parent),
    cloud = ctx.officialCodeHelperCloud?.();
  if (
    !alive() ||
    !current() ||
    !cloud?.available() ||
    !parent.cwd ||
    parent.threadId !== input.threadId ||
    parent.turns.at(-1)?.id !== input.turnId ||
    parent.turns.at(-1)?.status !== "inProgress" ||
    input.signal?.aborted
  )
    throw Error("This cloud session request is no longer available.");
  if (
    !input.toolCallId ||
    !input.title.trim() ||
    !input.brief.trim() ||
    input.brief.length > 32000
  )
    throw Error("A valid tool call, title and brief are required.");
  const reservationKey = `${parent.id}:${input.turnId}:${input.toolCallId}`;
  if (uncertainReservations.get(ctx.store)?.has(reservationKey))
    throw Error(
      "This cloud request could not be saved safely. Check it before retrying.",
    );
  const previous = parent.codeCloudHelperStarts?.find(
    (row) => row.toolCallId === input.toolCallId && row.turnId === input.turnId,
  );
  if (previous) {
    if (
      previous.title !== input.title ||
      previous.brief !== input.brief ||
      previous.threadId !== input.threadId ||
      previous.requestedRepository !== input.repository ||
      previous.requestedEnvironment !== input.environment
    )
      throw Error("This cloud start conflicts with its saved request.");
    if (previous.state === "pending")
      void dispatch(ctx, parent, previous, alive);
    return { taskId: previous.taskId };
  }
  ctx.allowedFolder(parent.cwd, parent.environment);
  const sourceCwd = parent.cwd,
    providerId = parent.providerId,
    model = parent.model;
  const repo = input.repository ?? workspaceRepository(sourceCwd);
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.length > 210)
    throw Error("A GitHub repository is required for Cloud Code.");
  const environments = await cloud.listCloudEnvironments();
  if (!alive() || !current())
    throw Error("The cloud request changed. Nothing started.");
  const named = input.environment?.trim();
  const matches = named
    ? environments.filter((row) => row.id === named)
    : environments.filter((row) => row.id === "default");
  const byName =
    named && !matches.length
      ? environments.filter(
          (row) => row.name.trim().toLowerCase() === named.toLowerCase(),
        )
      : matches;
  if (byName.length !== 1)
    throw Error(
      "Choose one available cloud environment by its unique name or ID.",
    );
  const selected = byName[0];
  const target = codeCloudSideSessionTarget.parse({
    environmentId: selected.id,
    repository: repo,
    model,
    permissionMode: "default",
  });
  const fenced = () =>
    alive() &&
    current() &&
    !input.signal?.aborted &&
    parent.cwd === sourceCwd &&
    parent.providerId === providerId &&
    parent.model === model &&
    parent.threadId === input.threadId &&
    parent.turns.at(-1)?.id === input.turnId &&
    parent.turns.at(-1)?.status === "inProgress" &&
    (input.repository !== undefined || workspaceRepository(sourceCwd) === repo);
  if (!fenced()) throw Error("The cloud request changed. Nothing started.");
  const answer = await ctx.engine.requestAppApproval(
    parent.id,
    {
      threadId: input.threadId,
      turnId: input.turnId,
      serverName: "ccd_session",
      mode: "form",
      message: `Allow starting “${approvalLabel(input.title)}” in cloud environment “${approvalLabel(selected.name)}” on GitHub repository ${repo}?`,
      requestedSchema: {
        type: "object",
        properties: {
          decision: { type: "string", enum: ["once"], enumNames: ["Allow"] },
        },
        required: ["decision"],
      },
    },
    input.signal,
  );
  if (answer?.action !== "accept")
    throw Error("Cloud placement was not approved. Nothing started.");
  if (!fenced()) throw Error("The cloud request changed. Nothing started.");
  const latest = await cloud.listCloudEnvironments();
  if (
    !fenced() ||
    !isDeepStrictEqual(
      latest.find((row) => row.id === selected.id),
      selected,
    )
  )
    throw Error("The cloud environment changed. Nothing started.");
  if (
    parent.codeCloudHelperStarts?.some(
      (row) =>
        row.toolCallId === input.toolCallId && row.turnId === input.turnId,
    )
  )
    throw Error("This cloud request is already being started.");
  const existingIds = new Set(
    (parent.codeCloudHelperStarts ?? []).map((row) => row.taskId),
  );
  let taskId: string;
  do taskId = `task_${randomBytes(4).toString("hex")}`;
  while (existingIds.has(taskId));
  const start: CodeCloudHelperStart = {
    taskId,
    requestId: randomUUID(),
    toolCallId: input.toolCallId,
    threadId: input.threadId,
    turnId: input.turnId,
    title: input.title,
    brief: input.brief,
    requestedEnvironment: input.environment,
    requestedRepository: input.repository,
    target,
    environmentUpdatedAt: selected.updatedAt,
    environmentHash: environmentHash(selected),
    createdAt: Date.now(),
    state: "pending",
  };
  try {
    save(ctx, parent, [...(parent.codeCloudHelperStarts ?? []), start], fenced);
  } catch (error) {
    const uncertain = uncertainReservations.get(ctx.store) ?? new Set<string>();
    uncertainReservations.set(ctx.store, uncertain);
    uncertain.add(reservationKey);
    throw error;
  }
  void dispatch(ctx, parent, start, alive);
  return { taskId };
}

export function registerCodeHelperCloud(ctx: AppContext) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const removeActivated = ctx.onAccountActivated(() => {
    cancel();
    const store = ctx.store,
      engine = ctx.engine,
      owner = ctx.activeAccount?.id;
    const identity = ctx.accountActivationIdentity,
      deadline = Date.now() + 60_000;
    const current = () =>
      !!owner &&
      identity !== undefined &&
      !ctx.accountRetiring &&
      ctx.activeAccount?.id === owner &&
      ctx.accountActivationIdentity === identity &&
      ctx.store === store &&
      ctx.engine === engine;
    const retryWhenReady = () => {
      timer = undefined;
      if (!current()) return;
      const pending = store.conversations.flatMap((parent) => {
        const alive = activation(ctx, parent);
        return alive()
          ? (parent.codeCloudHelperStarts ?? [])
              .filter((row) => row.state === "pending")
              .map((start) => ({ parent, start, alive }))
          : [];
      });
      if (!pending.length) return;
      if (ctx.officialCodeHelperCloud?.()?.available()) {
        for (const { parent, start, alive } of pending)
          void dispatch(ctx, parent, start, alive);
      } else if (Date.now() < deadline) {
        timer = setTimeout(retryWhenReady, 500);
        timer.unref();
      }
    };
    retryWhenReady();
  });
  const removeDeactivating = ctx.onAccountDeactivating(cancel);
  return () => {
    cancel();
    removeActivated();
    removeDeactivating();
  };
}
