import { z } from "zod";
import {
  approvalKind,
  approvalResponse,
  type ApprovalChoice,
} from "./approval-response";
import { bridgeMethods } from "./bridge-methods";
import type { InterruptTarget } from "./interrupt-target";
import type {
  DeviceInfo,
  DeviceMethod,
  DeviceConversation,
  DeviceConversationSummary,
  DeviceDirectory,
  DeviceNewSessionInput,
  DeviceSendInput,
} from "./remote-devices";
import type { Approval } from "./types";

export type DispatchTask = DeviceConversationSummary;

export interface DispatchTaskTarget {
  deviceId: string;
  conversationId: string;
}

export type DispatchDeliveryInput = Pick<
  DeviceNewSessionInput,
  "cwd" | "text"
> &
  Required<Pick<DeviceNewSessionInput, "mode">> & { deviceId: string };
export type DispatchFollowUpInput = DeviceSendInput & { deviceId: string };
export type DispatchInterruptInput = DispatchTaskTarget & {
  expected?: InterruptTarget;
};

export type DispatchApprovalDecision =
  | { choice: ApprovalChoice }
  | { answers: Record<string, { answers: string[] }> }
  | {
      action: "accept" | "decline" | "cancel";
      content?: Record<string, unknown>;
    };

export interface DispatchApprovalInput extends DispatchTaskTarget {
  approvalId: Approval["id"];
  decision: DispatchApprovalDecision;
}

export function dispatchApprovalResponse(
  approval: Approval,
  decision: DispatchApprovalDecision,
) {
  switch (approvalKind(approval)) {
    case "questions":
      if ("answers" in decision) return decision;
      break;
    case "elicitation":
      if ("action" in decision)
        return {
          action: decision.action,
          content: decision.content ?? null,
          _meta: null,
        };
      if ("choice" in decision)
        return approvalResponse(approval, decision.choice);
      break;
    default:
      if ("choice" in decision)
        return approvalResponse(approval, decision.choice);
  }
  throw new Error("This answer doesn't match the computer's request.");
}

export const dispatchDeliveryValueSchema = z
  .object({
    conversationId: z.string().min(1),
  })
  .nullable();

export const dispatchDeliveryResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("accepted"),
    value: dispatchDeliveryValueSchema,
  }),
  z.object({
    status: z.literal("rejected"),
    code: z.enum(["invalid", "unavailable"]),
    message: z.string(),
  }),
  z.object({ status: z.literal("unknown"), message: z.string() }),
]);

export type DispatchDeliveryResponse = z.infer<
  typeof dispatchDeliveryResponseSchema
>;

interface DispatchDeliveryLabel {
  id: string;
  deviceId: string;
  title: string;
}

export type DispatchDeliveryStatus = DispatchDeliveryLabel &
  (
    | { state: "pending" }
    | { state: "failed" | "unknown"; error: string }
    | { state: "delivered"; conversationId?: string }
  );

export interface DispatchStatus {
  machinesFailed?: boolean;
  signedIn?: boolean;
  appLink: string;
  phoneLink?: string;
  paired: boolean;
  pairedDeviceIds?: string[];
  local?: {
    id: string;
    online: boolean;
    cause?: "sign_in" | "network" | "retry" | "update";
  };
  devices: DeviceInfo[];
  onlineDeviceIds: string[];
  pending: DispatchDeliveryLabel[];
  deliveries?: DispatchDeliveryStatus[];
}

export interface OfficialDispatch {
  status(retry?: boolean): Promise<DispatchStatus>;
  tasks(deviceId: string): Promise<DispatchTask[]>;
  directories(deviceId: string): Promise<DeviceDirectory[]>;
  deliver(input: DispatchDeliveryInput): Promise<DispatchDeliveryStatus>;
  details(target: DispatchTaskTarget): Promise<DeviceConversation>;
  followUp(input: DispatchFollowUpInput): Promise<DispatchDeliveryStatus>;
  approve(input: DispatchApprovalInput): Promise<void>;
  interrupt(target: DispatchInterruptInput): Promise<void>;
  trust(deviceId: string): Promise<void>;
  retry(id: string): Promise<DispatchDeliveryStatus | undefined>;
  remove(id: string): Promise<void>;
}

export interface DispatchAPI {
  dispatchStatus: OfficialDispatch["status"];
  dispatchTasks(deviceId?: string): Promise<DispatchTask[]>;
  dispatchCall(
    deviceId: string,
    method: DeviceMethod,
    args: unknown[],
  ): Promise<unknown>;
  dispatchEnqueue(
    deviceId: string,
    method: "newSession" | "send",
    input: unknown,
  ): Promise<void>;
  dispatchDirectories: OfficialDispatch["directories"];
  dispatchDeliver: OfficialDispatch["deliver"];
  dispatchDetails: OfficialDispatch["details"];
  dispatchFollowUp: OfficialDispatch["followUp"];
  dispatchApprove: OfficialDispatch["approve"];
  dispatchInterrupt: OfficialDispatch["interrupt"];
  dispatchTrust: OfficialDispatch["trust"];
  dispatchRetry: OfficialDispatch["retry"];
  dispatchRemove: OfficialDispatch["remove"];
}

export const dispatchMethods = bridgeMethods<DispatchAPI>({
  dispatchStatus: true,
  dispatchTasks: true,
  dispatchCall: true,
  dispatchEnqueue: true,
  dispatchDirectories: true,
  dispatchDeliver: true,
  dispatchDetails: true,
  dispatchFollowUp: true,
  dispatchApprove: true,
  dispatchInterrupt: true,
  dispatchTrust: true,
  dispatchRetry: true,
  dispatchRemove: true,
});
