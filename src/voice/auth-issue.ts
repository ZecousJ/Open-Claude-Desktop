import type { AuthIssue } from "../../shared/auth-issue";

// (live claude.ai bundle, 2026-10-14, shared-7-CO8eplZ3.js)
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
