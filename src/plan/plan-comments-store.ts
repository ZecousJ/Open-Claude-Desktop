import { useSyncExternalStore } from "react";
import type { PlanComment } from "../../shared/plan-comments";

const empty: PlanComment[] = [];
const comments = new Map<string, PlanComment[]>();
const enabled = new Set<string>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const planCommentKey = (conversationId: string, itemId: string) =>
  JSON.stringify([conversationId, itemId]);

export const planComments = {
  get: (planId: string) => comments.get(planId) ?? empty,
  active: (planId: string) => enabled.has(planId),
  enable(planId: string, value: boolean) {
    if (value) enabled.add(planId);
    else enabled.delete(planId);
    emit();
  },
  add(planId: string, entry: Omit<PlanComment, "id">) {
    comments.set(planId, [
      ...this.get(planId),
      { ...entry, id: crypto.randomUUID() },
    ]);
    emit();
  },
  update(planId: string, id: string, comment: string) {
    comments.set(
      planId,
      this.get(planId).map((entry) =>
        entry.id === id ? { ...entry, comment } : entry,
      ),
    );
    emit();
  },
  remove(planId: string, id: string) {
    comments.set(
      planId,
      this.get(planId).filter((entry) => entry.id !== id),
    );
    emit();
  },
  clear(planId: string) {
    comments.delete(planId);
    emit();
  },
};

export function usePlanComments(planId: string) {
  return useSyncExternalStore(
    subscribe,
    () => planComments.get(planId),
    () => planComments.get(planId),
  );
}

export function usePlanCommentsEnabled(planId: string) {
  return useSyncExternalStore(
    subscribe,
    () => planComments.active(planId),
    () => false,
  );
}
