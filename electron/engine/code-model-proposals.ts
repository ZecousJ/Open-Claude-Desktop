import { codeModelProposalSession } from "./code-helper-targets";
import { prepareCodeCloudOffer, fillCodeCloudOffer } from "./code-helper-cloud";
import { randomBytes, randomUUID } from "node:crypto";
import type { z } from "zod";
import type { AppContext } from "../app/app-context";
import type { Store } from "../store/store";
import type { Conversation } from "../../shared/types";
import { preference } from "../../shared/settings-extras";
import {
  codeModelProposalBrief,
  type CodeModelProposal,
  type codeModelProposalAction,
} from "../../shared/official-code-model-proposal";
import {
  codeExecutionSettings,
  codePermissionModeOf,
} from "../../shared/code-session-permissions";
import { newConversation, type SendInput } from "./new-conversation";

type Action = z.infer<typeof codeModelProposalAction>;
type ProposalAction =
  | Action
  | {
      kind: "fill";
      prompt: string;
      background: string;
      wakeWhenDone?: boolean;
    };
type ProposalResult = boolean | { sessionId: string } | { taskId: string };
type Claim = Extract<CodeModelProposal["state"], { childId: string }>;
type Caller = { parent: Conversation; current: () => boolean };
const proposalLifetime = 7 * 24 * 60 * 60 * 1000;
type Operation = {
  kind: ProposalAction["kind"];
  result: Promise<ProposalResult>;
};
const accountOperations = new WeakMap<Store, Map<string, Operation>>();
const offerWaiters = new WeakMap<
  Store,
  Map<string, (accepted: boolean) => void>
>();

function saveProposals(
  ctx: AppContext,
  caller: Caller,
  items: CodeModelProposal[],
  addition?: Conversation,
) {
  ctx.store.commitLocalCodeHistory(
    caller.parent,
    { codeModelProposals: items },
    addition,
    caller.current,
  );
  ctx.engine.changed(caller.parent, true);
  if (addition) ctx.engine.changed(addition, true);
}

function replace(
  ctx: AppContext,
  caller: Caller,
  original: CodeModelProposal,
  next: CodeModelProposal,
  addition?: Conversation,
) {
  const rows = caller.parent.codeModelProposals ?? [];
  if (!rows.includes(original))
    throw Error("This Code proposal changed. Reopen the parent session.");
  saveProposals(
    ctx,
    caller,
    rows.map((row) => (row === original ? next : row)),
    addition,
  );
  return next;
}

export function recordCodeModelProposal(
  ctx: AppContext,
  caller: Caller,
  input: Omit<CodeModelProposal, "id" | "createdAt" | "expiresAt" | "state">,
) {
  const now = Date.now();
  const rows = (caller.parent.codeModelProposals ?? []).filter(
    (row) => row.expiresAt > now,
  );
  const visible = rows.filter(
    (row) => row.state.kind === "pending" || row.state.kind === "claimed",
  );
  if (visible.length >= 20)
    throw Error(
      "There are already 20 pending Code proposals. Dismiss one before proposing another.",
    );
  if (input.kind === "offer" && visible.some((row) => row.kind === "offer"))
    throw Error("A Code session offer is already awaiting a decision.");
  let id: string;
  do id = `task_${randomBytes(4).toString("hex")}`;
  while (rows.some((row) => row.id === id));
  const proposal: CodeModelProposal = {
    ...input,
    id,
    createdAt: now,
    expiresAt: now + proposalLifetime,
    state: { kind: "pending" },
  };
  saveProposals(ctx, caller, [...rows, proposal]);
  return proposal;
}

export function waitForModelOffer(
  store: Store,
  parentId: string,
  taskId: string,
  signal: AbortSignal,
) {
  if (signal.aborted) return Promise.resolve(false);
  const key = `${parentId}:${taskId}`;
  const waiters =
    offerWaiters.get(store) ?? new Map<string, (accepted: boolean) => void>();
  offerWaiters.set(store, waiters);
  return new Promise<boolean>((resolve) => {
    const settle = (accepted: boolean) => {
      signal.removeEventListener("abort", abort);
      waiters.delete(key);
      resolve(accepted);
    };
    const abort = () => settle(false);
    waiters.set(key, settle);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function findLinkedChild(
  store: Store,
  parent: Conversation,
  proposal: CodeModelProposal,
  claim: Claim,
  owner: string,
) {
  const candidate = store.conversations.find((row) => row.id === claim.childId);
  return codeModelProposalSession(candidate, owner) &&
    candidate.parentSessionId === parent.id &&
    candidate.nativeSideSession?.taskId === proposal.id
    ? candidate
    : undefined;
}

function startInput(
  parent: Conversation,
  proposal: CodeModelProposal,
  claim: Claim,
  text: string,
): SendInput {
  const { cwd, model, worktree, effort, codePermissionMode } = claim.placement;
  return {
    mode: "code",
    text,
    attachments: [],
    parentSessionId: parent.id,
    cwd,
    model,
    worktree,
    effort,
    codePermissionMode,
    newConversationId: claim.childId,
    providerId: proposal.providerId,
    projectId: cwd === parent.cwd ? parent.projectId : undefined,
    officialCodeEventId: proposal.id,
  };
}

export async function actOnCodeModelProposal(
  ctx: AppContext,
  parentId: string,
  taskId: string,
  action: ProposalAction,
  nativeCurrent: () => boolean,
): Promise<ProposalResult> {
  const { store, engine, accountActivationIdentity: identity } = ctx;
  const owner = ctx.activeAccount?.id;
  const parent = store.conversations.find((row) => row.id === parentId);
  if (
    !owner ||
    identity === undefined ||
    !codeModelProposalSession(parent, owner)
  )
    return false;
  const current = () =>
    nativeCurrent() &&
    !ctx.accountRetiring &&
    ctx.accountActivationIdentity === identity &&
    ctx.activeAccount?.id === owner &&
    ctx.store === store &&
    ctx.engine === engine &&
    store.conversations.includes(parent) &&
    codeModelProposalSession(parent, owner);
  if (!current()) return false;
  const initial = parent.codeModelProposals?.find((row) => row.id === taskId);
  if (!initial || initial.state.kind === "dismissed") return false;
  let proposal: CodeModelProposal = initial;
  const key = `${parentId}:${taskId}`;
  const operations =
    accountOperations.get(store) ?? new Map<string, Operation>();
  accountOperations.set(store, operations);
  const pending = proposal.state.kind === "pending";
  const caller = { parent, current };
  if (action.kind === "pop") {
    if (action.launched)
      return (
        "childId" in proposal.state &&
        !!findLinkedChild(store, parent, proposal, proposal.state, owner)
      );
    if (
      operations.has(key) ||
      proposal.state.kind === "started" ||
      proposal.state.kind === "cloudAccepted"
    )
      return false;
    if (
      proposal.state.kind === "claimed" &&
      findLinkedChild(store, parent, proposal, proposal.state, owner)?.turns
        .length
    )
      return false;
    replace(ctx, caller, proposal, {
      ...proposal,
      state: { kind: "dismissed" },
    });
    offerWaiters.get(store)?.get(key)?.(false);
    return true;
  }
  if (
    action.kind === "acceptOffer" &&
    (proposal.kind !== "offer" ||
      (action.selection.auto &&
        (action.selection.target !== "local" ||
          preference(store.settings, "ccNewTaskPrompt") !== "new_session")))
  )
    return false;
  if (action.kind === "start" && proposal.kind !== "suggestion") return false;
  if (action.kind === "fill" && (proposal.kind !== "offer" || pending))
    return false;
  if (
    action.kind === "acceptOffer" &&
    proposal.state.kind !== "started" &&
    (!offerWaiters.get(store)?.has(key) ||
      parent.turns.at(-1)?.id !== proposal.sourceTurnId ||
      parent.turns.at(-1)?.status !== "inProgress")
  )
    return false;
  if (
    action.kind === "fill" &&
    (parent.turns.at(-1)?.id !== proposal.sourceTurnId ||
      parent.turns.at(-1)?.status !== "inProgress")
  )
    return false;
  const active = operations.get(key);
  if (active) {
    if (active.kind !== action.kind) return false;
    const joined = await active.result;
    return current() ? joined : false;
  }
  if (proposal.expiresAt <= Date.now() && pending) return false;
  if (action.kind === "acceptOffer" && action.selection.target === "cloud") {
    if (!pending) return false;
    const selection = action.selection;
    const operation = {
      kind: action.kind,
      result: (async (): Promise<ProposalResult> => {
        const claim = await prepareCodeCloudOffer(
          ctx,
          parent,
          proposal,
          selection,
          current,
        );
        if (
          !current() ||
          parent.turns.at(-1)?.id !== proposal.sourceTurnId ||
          parent.turns.at(-1)?.status !== "inProgress" ||
          !parent.codeModelProposals?.includes(proposal)
        )
          return false;
        proposal = replace(ctx, caller, proposal, {
          ...proposal,
          state: claim,
        });
        offerWaiters.get(store)?.get(key)?.(true);
        return true;
      })(),
    };
    operations.set(key, operation);
    try {
      return await operation.result;
    } finally {
      if (operations.get(key) === operation) operations.delete(key);
    }
  }
  if (proposal.state.kind === "cloudAccepted") {
    if (action.kind !== "fill") return false;
    return fillCodeCloudOffer(
      ctx,
      parent,
      proposal,
      proposal.state,
      codeModelProposalBrief("fresh", action.prompt, action.background),
      current,
    );
  }
  const providerId = proposal.providerId;
  const provider = store.settings.providers.find(
    (row) => row.id === providerId,
  );
  if (
    !provider ||
    parent.providerId !== proposal.providerId ||
    parent.cwd !== proposal.sourceCwd
  )
    throw Error(
      "The proposal's folder or model service changed. Ask for a new proposal.",
    );

  let claim: Claim;
  if (proposal.state.kind === "pending") {
    if (action.kind === "fill") return false;
    const picks =
      action.kind === "start" ? action.picks : action.selection.picks;
    const model =
      picks?.model === "default"
        ? provider.model
        : (picks?.model ?? proposal.model ?? parent.model);
    if (![provider.model, parent.model, ...provider.models].includes(model))
      throw Error("The selected Code model is unavailable.");
    const worktree =
      proposal.context === "fresh" &&
      (picks?.useWorktree ??
        (action.kind === "acceptOffer"
          ? action.selection.useWorktree
          : undefined) ??
        proposal.worktree ??
        (action.kind === "start" ? action.useWorktree : undefined) ??
        !!parent.worktree);
    const cwd = worktree
      ? (parent.worktree?.origin ?? proposal.sourceCwd)
      : proposal.sourceCwd;
    ctx.allowedFolder(cwd, parent.environment);
    const permission = picks?.permissionMode;
    const modes = {
      default: "manual",
      acceptEdits: "acceptEdits",
      plan: "plan",
      auto: "auto",
      bypassPermissions: "bypass",
    } as const;
    // Explicit picks are from the native card. Tool-proposed starts inherit the parent's permission mode.
    claim = {
      kind: "claimed",
      childId:
        (action.kind === "start"
          ? action.requestedId
          : undefined
        )?.toLowerCase() ?? randomUUID(),
      placement: {
        cwd,
        model,
        worktree,
        effort: picks?.effort ?? proposal.effort ?? parent.effort,
        codePermissionMode: permission
          ? modes[permission]
          : codePermissionModeOf(codeExecutionSettings(store.settings, parent)),
      },
    };
    if (
      store.conversations.some((row) => row.id.toLowerCase() === claim.childId)
    )
      throw Error("The Code child session identifier is already in use.");
    proposal = replace(ctx, caller, proposal, { ...proposal, state: claim });
  } else {
    if (!("childId" in proposal.state)) return false;
    claim = proposal.state;
  }

  const approved = proposal;
  const scope = () => {
    if (
      !current() ||
      parent.cwd !== approved.sourceCwd ||
      parent.providerId !== approved.providerId ||
      !parent.codeModelProposals?.includes(approved)
    )
      return false;
    try {
      ctx.allowedFolder(claim.placement.cwd, parent.environment);
      return true;
    } catch {
      return false;
    }
  };
  const result = () => ({ sessionId: `local_${claim.childId}` });
  const dispatch = async (): Promise<ProposalResult> => {
    let child = findLinkedChild(store, parent, proposal, claim, owner);
    if (!child && proposal.state.kind === "started") return false;
    if (!scope()) throw Error("The proposal's folder is no longer available.");
    if (!child) {
      if (action.kind === "fill") return false;
      const input = startInput(parent, proposal, claim, "");
      if (proposal.context === "fork") {
        const existing = store.conversations.find(
          (row) => row.id === claim.childId,
        );
        if (!existing)
          await engine.forkConversation(
            parent.id,
            undefined,
            undefined,
            undefined,
            scope,
            {
              conversationId: claim.childId,
              ...(parent.worktree ? { separateWorktree: true } : {}),
            },
          );
        child = store.conversations.find(
          (row) =>
            row.id === claim.childId &&
            row.forkedFrom?.conversationId === parent.id,
        );
        if (!child || !scope())
          throw Error("The Code fork could not be confirmed.");
        store.commitLocalCodeHistory(
          child,
          {
            title: proposal.title,
            titleSetByUser: true,
            nativeSideSession: { taskId },
            codeHelperParentTurnId: proposal.sourceTurnId,
          },
          undefined,
          scope,
        );
        engine.changed(child, true);
      } else {
        child = newConversation(
          input,
          provider,
          claim.placement.cwd,
          store.settings,
        );
        child.title = proposal.title;
        child.titleSetByUser = true;
        child.nativeSideSession = { taskId };
        child.codeHelperParentTurnId = proposal.sourceTurnId;
        if (parent.sessionAuthors)
          child.sessionAuthors = structuredClone(parent.sessionAuthors);
        saveProposals(
          ctx,
          { parent, current: scope },
          parent.codeModelProposals ?? [],
          child,
        );
      }
    }
    if (action.kind === "acceptOffer") {
      if (proposal.state.kind !== "started")
        proposal = replace(ctx, caller, proposal, {
          ...proposal,
          state: { ...claim, kind: "started" },
        });
      offerWaiters.get(store)?.get(key)?.(true);
      return true;
    }
    let receipt = child.turns.find(
      (turn) => turn.officialCodeEventId === taskId,
    );
    if (!receipt) {
      if (proposal.context === "fresh" && child.turns.length)
        throw Error(
          "The linked Code session has already received another message.",
        );
      if (action.wakeWhenDone)
        store.commitLocalCodeHistory(
          child,
          { codeHelperWakeWhenDone: true },
          undefined,
          scope,
        );
      const text =
        action.kind === "fill"
          ? codeModelProposalBrief("fresh", action.prompt, action.background)
          : proposal.brief;
      const input = startInput(parent, proposal, claim, text);
      delete input.newConversationId;
      input.conversationId = child.id;
      if (proposal.context === "fork") {
        input.cwd = child.cwd;
        input.projectId = child.projectId;
      }
      const send = engine.send(input, undefined, false, {
        current: scope,
        interactive: false,
        newTaskResolved: true,
        codeModelProposalFirstTurn: true,
        codeWorktreeFolderTrusted: (folder) => {
          try {
            ctx.allowedFolder(folder, parent.environment);
            return scope();
          } catch {
            return false;
          }
        },
      });
      try {
        await send;
      } catch (error) {
        if (
          !scope() ||
          !child.turns.some((turn) => turn.officialCodeEventId === taskId)
        )
          throw error;
      }
      receipt = child.turns.find((turn) => turn.officialCodeEventId === taskId);
    }
    if (!scope())
      throw Error(
        "The account or folder changed. Open the saved child to check the result.",
      );
    if (proposal.state.kind !== "started")
      replace(ctx, caller, proposal, {
        ...proposal,
        state: { ...claim, kind: "started" },
      });
    if (
      !receipt ||
      receipt.status === "failed" ||
      receipt.id.startsWith("pending-")
    )
      throw Error(
        `The first message could not be confirmed. Open ${result().sessionId} to check or retry it.`,
      );
    return result();
  };
  const operation = {
    kind: action.kind,
    result: Promise.resolve().then(dispatch),
  };
  operations.set(key, operation);
  try {
    return await operation.result;
  } finally {
    operations.delete(key);
  }
}
