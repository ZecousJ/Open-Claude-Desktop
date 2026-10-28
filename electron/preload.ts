import { contextBridge, ipcRenderer } from "electron";
import { bridgeErrorMessage, desktopMethods } from "../shared/desktop-bridge";

const api: Record<string, any> = {};
const frameListeners = new Set<(event: any) => void>();
let framePort: MessagePort | undefined;
ipcRenderer.on("app:preview-frame-port", (event) => {
  framePort?.close();
  framePort = event.ports[0];
  if (!framePort) return;
  framePort.onmessage = (message) => {
    for (const listener of frameListeners) listener(message.data);
  };
  framePort.start();
});
for (const method of desktopMethods)
  api[method] = (...args: any[]) =>
    ipcRenderer.invoke("app:" + method, ...args).catch((error: unknown) => {
      // The window shows the main process's message, not Electron's wrapper.
      throw new Error(bridgeErrorMessage(error));
    });
api.onEvent = (callback: (event: any) => void) => {
  frameListeners.add(callback);
  const listener = (_event: any, value: any) => callback(value);
  ipcRenderer.on("app:event", listener);
  return () => {
    frameListeners.delete(callback);
    ipcRenderer.removeListener("app:event", listener);
  };
};
contextBridge.exposeInMainWorld("desktop", api);
