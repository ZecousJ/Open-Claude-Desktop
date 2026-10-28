import { bridgeMethods } from "./bridge-methods";
import type {
  DeviceInfo,
  DeviceMethod,
  DeviceConversationSummary,
} from "./remote-devices";

export interface DispatchStatus {
  machinesFailed?: boolean;
  signedIn?: boolean;
  appLink: string;
  paired: boolean;
  local?: {
    id: string;
    online: boolean;
    cause?: "sign_in" | "network" | "retry" | "update";
  };
  devices: DeviceInfo[];
  onlineDeviceIds: string[];
  pending: { id: string; deviceId: string; title: string }[];
}

export interface DispatchAPI {
  dispatchStatus(retry?: boolean): Promise<DispatchStatus>;
  dispatchTasks(deviceId?: string): Promise<DeviceConversationSummary[]>;
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
}

export const dispatchMethods = bridgeMethods<DispatchAPI>({
  dispatchStatus: true,
  dispatchTasks: true,
  dispatchCall: true,
  dispatchEnqueue: true,
});
