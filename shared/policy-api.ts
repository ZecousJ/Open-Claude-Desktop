/**
 * The administrator's policy and notices (package C2). Handlers are in
 * `electron/ipc/policy.ts`; the policy's fields are in
 * `shared/client-policy.ts`.
 */
import type { Announcement, ClientPolicy } from "./client-policy";
import { bridgeMethods } from "./bridge-methods";

export interface PolicyAPI {
  /** What the administrator allows this account (Sub2API plus the operator policy file). */
  clientPolicy(): Promise<ClientPolicy>;
  /** Administrator notices: Sub2API announcements, or the policy file for local accounts. */
  announcements(): Promise<Announcement[]>;
  markAnnouncementRead(id: string): Promise<Announcement[]>;
}

export const policyMethods = bridgeMethods<PolicyAPI>({
  clientPolicy: true,
  announcements: true,
  markAnnouncementRead: true,
});
