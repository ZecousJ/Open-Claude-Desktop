import { bridgeMethods } from "./bridge-methods";

export interface CodeEmailStatus {
  /** A cloud runner, account address and configured mail service are available. */
  available: boolean;
}

export interface CodeEmailAPI {
  codeEmailStatus(): Promise<CodeEmailStatus>;
}

export const codeEmailMethods = bridgeMethods<CodeEmailAPI>({
  codeEmailStatus: true,
});

export interface CodeEmailEvent {
  conversationId: string;
  /** Stable per turn or approval, for duplicate suppression. */
  eventId: string;
  outcome: "completed" | "failed" | "needs_attention";
}
