import { chatDeviceUnavailable } from "../../shared/chat-devices-api";
import type { IpcHandle } from "../app/app-context";

/** Standalone/old desktop hosts have no remote binding protocol. CloudRouter
 * replaces these only while a real authenticated runner is connected. */
export function registerChatDevicesUnavailable(handle: IpcHandle) {
  const unavailable = () => {
    throw new Error(chatDeviceUnavailable);
  };
  handle("chatDevices", unavailable);
  handle("sendOnChatDevice", unavailable);
  handle("setChatDevice", unavailable);
}
