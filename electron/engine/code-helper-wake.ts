import { randomUUID } from "node:crypto";
import type { AppContext } from "../app/app-context";
import { codeModelProposalSession } from "./code-helper-targets";
import { pendingCodeHelperReports } from "./code-helper-reports";
import { codeLimitAutoResumeFor } from "./code-limit-auto-resume";

export function registerCodeHelperWake(ctx: AppContext) {
  let stop: (() => void) | undefined;
  ctx.onAccountActivated(({ id: owner }) => {
    stop?.();
    const { engine, store, accountActivationIdentity } = ctx;
    let sending = false;
    let checkQueued = false;
    const current = () =>
      !ctx.accountRetiring &&
      ctx.activeAccount?.id === owner &&
      ctx.engine === engine &&
      ctx.store === store &&
      ctx.accountActivationIdentity === accountActivationIdentity;
    const noUserInput = (id: string) =>
      !engine.approvals.some((request) => request.conversationId === id) &&
      !codeLimitAutoResumeFor(ctx)?.hasHeldDraft(`local_${id}`);
    const tick = () => {
      checkQueued = false;
      if (!current() || sending || engine.pendingSend || engine.ownBusy())
        return;
      const parentIds = new Set(
        store.conversations.flatMap((child) =>
          child.codeHelperWakeWhenDone && child.parentSessionId
            ? [child.parentSessionId]
            : [],
        ),
      );
      for (const parent of store.conversations) {
        if (!parentIds.has(parent.id)) continue;
        const tail = parent.turns.at(-1);
        if (
          !codeModelProposalSession(parent, owner) ||
          !engine.owns(parent) ||
          !parent.threadId ||
          !tail ||
          tail.status !== "completed" ||
          tail.userStopped ||
          parent.codeNewTask ||
          !noUserInput(parent.id)
        )
          continue;
        let wakes = 0;
        for (const turn of [...parent.turns].reverse()) {
          if (!turn.autoContinuation) break;
          if (turn.codeHelperWake) wakes++;
        }
        if (wakes >= 10) continue;
        const child = pendingCodeHelperReports(
          store.conversations,
          parent,
        ).find(
          (report) =>
            report.wakeable && report.child.codeHelperWakeWhenDone && !report.child.archived,
        )?.child;
        if (!child) continue;
        const awakeId = randomUUID();
        const { providerId, model, cwd, threadId } = parent;
        if (!cwd) continue;
        const wanted = () => {
          const latest = parent.turns.at(-1);
          if (
            !current() ||
            !store.conversations.includes(parent) ||
            !store.conversations.includes(child) ||
            !codeModelProposalSession(parent, owner) ||
            child.archived || child.parentSessionId !== parent.id ||
            parent.providerId !== providerId ||
            parent.model !== model ||
            parent.cwd !== cwd ||
            parent.threadId !== threadId ||
            parent.codeNewTask ||
            !noUserInput(parent.id) ||
            (latest !== tail && latest?.officialCodeEventId !== awakeId)
          )
            return false;
          try {
            ctx.allowedFolder(cwd, parent.environment);
            return true;
          } catch {
            return false;
          }
        };
        if (!wanted()) continue;
        sending = true;
        void engine
          .send(
            {
              conversationId: parent.id,
              mode: "code",
              cwd,
              providerId,
              model,
              text: "Review the linked Code session reports and continue the current task if work remains.",
              attachments: [],
              officialCodeEventId: awakeId,
            },
            undefined,
            false,
            {
              current: wanted,
              interactive: false,
              autoContinuation: true,
              newTaskResolved: true,
              codeHelperWakeChildId: child.id,
            },
          )
          .catch(() => {})
          .finally(() => {
            sending = false;
          });
        break;
      }
    };
    const request = () => {
      if (checkQueued) return;
      checkQueued = true;
      queueMicrotask(tick);
    };
    const listen = ctx.onEvent((event) => {
      if (event.type === "conversation" || event.type === "resync") request();
    });
    const timer = setInterval(request, 5000);
    timer.unref?.();
    request();
    stop = () => {
      clearInterval(timer);
      listen();
    };
  });
  ctx.onAccountDeactivating(() => {
    stop?.();
    stop = undefined;
  });
}
