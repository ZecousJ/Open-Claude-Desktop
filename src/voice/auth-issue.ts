import type { AuthIssue } from "../../shared/auth-issue";

let issue: AuthIssue | null = null;
const listeners = new Set<() => void>();

export const voiceAuthIssue = {
  read: () => issue,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  set(next: AuthIssue | null) {
    if (issue === next) return;
    issue = next;
    listeners.forEach((listener) => listener());
  },
};
