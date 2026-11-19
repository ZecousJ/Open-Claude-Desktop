import { createHash, randomUUID } from "node:crypto";
import { Listeners, type AppContext } from "../app/app-context";
import { inAdapterScope, newAdapterScope } from "../official-ui/api/scope";
import { flushState, readState, writeState } from "../official-ui/api/state";
import type { Conversation } from "../../shared/types";
import { onThisMachine } from "../../shared/types";

const stateKey = "code-limit-auto-resume";
const expiry = 6 * 60 * 60_000;
const maxAttempts = 3;
const continuationPrompt =
  "I hit my usage limit while you were working, but it has reset now. Please continue from where you left off.";

function localCode(conversation: Conversation) {
  return (
    conversation.mode === "code" &&
    !conversation.incognito &&
    !conversation.archived &&
    !conversation.scheduledRun &&
    !conversation.cloudHosted &&
    !conversation.cloudEnvironmentId &&
    !conversation.linkedComputerId &&
    !conversation.linkedToComputer &&
    !conversation.chatDeviceBinding &&
    !conversation.deviceChatOrigin &&
    !conversation.remoteControlStarted &&
    !conversation.remoteCodeWorktree &&
    onThisMachine(conversation.environment)
  );
}

function candidate(conversation: Conversation, now: number) {
  const turn = conversation.turns.at(-1);
  const hold = turn?.usageHold;
  if (
    !localCode(conversation) ||
    !conversation.threadId ||
    !turn ||
    turn.status !== "failed" ||
    turn.userStopped ||
    turn.dispatchDeliveryId ||
    turn.stopReason !== "usage_limit" ||
    hold?.window !== "five_hour" ||
    hold.resetsAt === null ||
    hold.providerId !== conversation.providerId ||
    hold.model !== conversation.model ||
    !Number.isSafeInteger(hold.resetsAt) ||
    Math.abs(hold.resetsAt - now) >= expiry
  )
    return;
  const resetsAt = hold.resetsAt;
  const jitter =
    2000 +
    (createHash("sha256").update(turn.id).digest().readUInt16LE() % 6000);
  let attempt = 0;
  for (let index = conversation.turns.length - 1; index > 0; index--) {
    const entry = conversation.turns[index];
    const prior = conversation.turns[index - 1].usageHold;
    if (
      !entry.autoContinuation ||
      prior?.window !== "five_hour" ||
      prior.resetsAt === null ||
      Math.abs(prior.resetsAt - resetsAt) >= 3600_000
    )
      break;
    attempt++;
  }
  return {
    conversation,
    turn,
    resetsAt,
    fireAtMs: resetsAt + 90_000 + jitter,
    attempt,
  };
}

type Candidate = NonNullable<ReturnType<typeof candidate>>;
type AccountLease = {
  id: string;
  engine: AppContext["engine"];
  store: AppContext["store"];
  generation: unknown;
  scope: ReturnType<typeof newAdapterScope>;
};
export type CodeLimitAutoResumeState = {
  seq: number;
  hostOwns: boolean;
  windows: {
    sessionId: string;
    resetsAt: number;
    attempt: number;
    optedIn: boolean;
    armed: boolean;
    fireAtMs?: number;
  }[];
};
export interface CodeLimitAutoResume {
  state(optOutAccount?: string): CodeLimitAutoResumeState;
  arm(sessionId: string, enabled: boolean): void;
  attend(window: object): void;
  hold(window: object, ids: string[]): void;
  release(window: object): void;
  subscribe(callback: (state: CodeLimitAutoResumeState) => void): () => void;
  hasHeldDraft(sessionId: string): boolean;
}

const controls = new WeakMap<AppContext, CodeLimitAutoResume>();
export const codeLimitAutoResumeFor = (ctx: AppContext) => controls.get(ctx);

export function registerCodeLimitAutoResume(ctx: AppContext) {
  const listeners = new Listeners<CodeLimitAutoResumeState>();
  const held = new Map<object, Set<string>>();
  const pages = new Set<object>();
  let account: AccountLease | undefined;
  let sequence = 1;
  let lastState = "";
  let sending = false;
  let nextSlot = 0;
  let timer: NodeJS.Timeout | undefined;

  const current = (lease: AccountLease) =>
    account === lease &&
    !ctx.accountRetiring &&
    ctx.accountActivationIdentity === lease.generation &&
    ctx.store === lease.store;
  const owned = (lease: AccountLease, conversation: Conversation) =>
    lease.engine.owns(conversation) &&
    (!conversation.sessionAuthors ||
      (conversation.sessionAuthors.ownerAccountUuid === lease.id &&
        conversation.sessionAuthors.viewerAccountUuid === lease.id));
  const candidates = (lease: AccountLease, now = Date.now()) =>
    lease.store.conversations.flatMap((conversation) => {
      const found = candidate(conversation, now);
      return found && owned(lease, conversation) ? [found] : [];
    });
  const optedIn = (lease: AccountLease) =>
    inAdapterScope(lease.scope, () => {
      const choice = readState<{ enabled?: unknown } | null>(
        stateKey,
        {},
      )?.enabled;
      if (typeof choice === "boolean") return choice;
      const preferences = readState<{
        epitaxyPrefs?: Record<string, unknown>;
      } | null>("preferences", {});
      return (
        preferences?.epitaxyPrefs?.[`autoResumeRateLimitOptIn.${lease.id}`] !==
        false
      );
    });
  const storeChoice = (lease: AccountLease, enabled: boolean) =>
    inAdapterScope(lease.scope, () => {
      writeState(stateKey, () => ({ enabled }));
      flushState(stateKey);
    });
  const holdExists = (sessionId: string) =>
    [...held.values()].some((sessions) => sessions.has(sessionId));
  const view = (): CodeLimitAutoResumeState => {
    const lease = account;
    const active = !!lease && current(lease);
    const enabled = active ? optedIn(lease) : false;
    return {
      seq: sequence,
      hostOwns: active,
      windows: active
        ? candidates(lease).map(
            ({ conversation, turn, resetsAt, fireAtMs, attempt }) => {
              const armed =
                enabled &&
                attempt < maxAttempts &&
                !turn.usageHold?.continuationId;
              return {
                sessionId: `local_${conversation.id}`,
                resetsAt: Math.floor(resetsAt / 1000),
                attempt,
                optedIn: enabled,
                armed,
                ...(armed ? { fireAtMs } : {}),
              };
            },
          )
        : [],
    };
  };
  const publish = () => {
    const state = view();
    const fingerprint = JSON.stringify([state.hostOwns, state.windows]);
    if (fingerprint === lastState) return;
    lastState = fingerprint;
    state.seq = ++sequence;
    listeners.emit(state);
  };
  const dispatch = async (
    lease: AccountLease,
    { conversation, turn }: Candidate,
  ) => {
    const eventId = randomUUID();
    const { threadId, providerId, model, cwd } = conversation;
    const sessionId = `local_${conversation.id}`;
    const stillWanted = () => {
      const tail = conversation.turns.at(-1);
      return (
        current(lease) &&
        pages.size > 0 &&
        localCode(conversation) &&
        owned(lease, conversation) &&
        !conversation.codeNewTask &&
        !lease.engine.approvals.some(
          (approval) => approval.conversationId === conversation.id,
        ) &&
        !holdExists(sessionId) &&
        optedIn(lease) &&
        lease.store.conversations.includes(conversation) &&
        conversation.threadId === threadId &&
        conversation.providerId === providerId &&
        conversation.model === model &&
        conversation.cwd === cwd &&
        ((tail === turn &&
          turn.status === "failed" &&
          !turn.userStopped &&
          turn.stopReason === "usage_limit") ||
          tail?.officialCodeEventId === eventId)
      );
    };
    if (
      !stillWanted() ||
      lease.engine.ownBusy() ||
      !turn.usageHold ||
      turn.usageHold.continuationId
    )
      return;
    if (cwd) ctx.services.workspaceTrust?.assert({ mode: "code", cwd });
    if (!stillWanted()) return;
    turn.usageHold.continuationId = eventId;
    try {
      lease.store.write(
        "conversations.json",
        lease.store.conversations.filter((row) => !row.incognito),
      );
    } catch (error) {
      delete turn.usageHold.continuationId;
      throw error;
    }
    nextSlot = Date.now() + 12_000;
    publish();
    await lease.engine.send(
      {
        conversationId: conversation.id,
        mode: "code",
        text: continuationPrompt,
        attachments: [],
        providerId,
        model,
        ...(cwd ? { cwd } : {}),
        officialCodeEventId: eventId,
      },
      undefined,
      false,
      {
        interactive: false,
        autoContinuation: true,
        newTaskResolved: true,
        current: stillWanted,
      },
    );
  };
  const pulse = () => {
    publish();
    const lease = account;
    const now = Date.now();
    if (
      !lease ||
      !current(lease) ||
      pages.size === 0 ||
      sending ||
      now < nextSlot ||
      !optedIn(lease) ||
      lease.engine.ownBusy()
    )
      return;
    const due = candidates(lease, now)
      .filter(
        ({ conversation, turn, attempt, fireAtMs }) =>
          fireAtMs <= now &&
          attempt < maxAttempts &&
          !turn.usageHold?.continuationId &&
          !holdExists(`local_${conversation.id}`) &&
          !lease.engine.approvals.some(
            (approval) => approval.conversationId === conversation.id,
          ) &&
          !conversation.codeNewTask,
      )
      .sort((first, second) => first.fireAtMs - second.fireAtMs)[0];
    if (!due) return;
    sending = true;
    void dispatch(lease, due)
      .catch(() => {})
      .finally(() => {
        sending = false;
        tick();
      });
  };
  const tick = () => {
    try {
      pulse();
    } catch (error) {
      console.error(
        "Code limit resume state update failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  controls.set(ctx, {
    state(optOutAccount) {
      const lease = account;
      if (
        lease &&
        current(lease) &&
        optOutAccount === lease.id &&
        optedIn(lease)
      )
        storeChoice(lease, false);
      publish();
      return view();
    },
    arm(sessionId, enabled) {
      const lease = account;
      if (
        !lease ||
        !current(lease) ||
        !candidates(lease).some(
          ({ conversation }) => `local_${conversation.id}` === sessionId,
        )
      )
        throw Error("This Code limit window is no longer available.");
      storeChoice(lease, enabled);
      pulse();
    },
    attend: (window) => {
      pages.add(window);
    },
    hold(window, ids) {
      if (!pages.has(window)) return;
      if (ids.length) held.set(window, new Set(ids));
      else held.delete(window);
    },
    release: (window) => {
      pages.delete(window);
      held.delete(window);
    },
    subscribe: (callback) => listeners.add(callback),
    hasHeldDraft: holdExists,
  });
  ctx.onAccountActivated((owner) => {
    clearInterval(timer);
    held.clear();
    pages.clear();
    const store = ctx.store;
    account = {
      id: owner.id,
      store,
      engine: ctx.engine,
      generation: ctx.accountActivationIdentity,
      scope: newAdapterScope(owner.id, store.root),
    };
    tick();
    timer = setInterval(tick, 5000);
    timer.unref?.();
  });
  ctx.onAccountDeactivating(() => {
    account = undefined;
    held.clear();
    pages.clear();
    clearInterval(timer);
    publish();
  });
  ctx.onEvent((event) => {
    if (account && (event.type === "conversation" || event.type === "resync"))
      publish();
  });
}
