/**
 * The find bar's preload (shared/find-in-page.ts). It exposes only the
 * bar's own calls as `window.findBar`, never the app's bridge: the bar's
 * page can search, stop and close, and hear when to focus, step or clear.
 */
import { contextBridge, ipcRenderer } from "electron";
import {
  findChannels,
  type FindBarBridge,
  type FindOptions,
} from "../shared/find-in-page";

/** Listens on a main → bar channel; returns the way to stop. */
function listen<T extends unknown[]>(
  channel: string,
  callback: (...args: T) => void,
) {
  const listener = (_event: unknown, ...args: unknown[]) =>
    callback(...(args as T));
  ipcRenderer.on(channel, listener);
  return () => void ipcRenderer.removeListener(channel, listener);
}

const bridge: FindBarBridge = {
  find: (query: string, options: FindOptions) =>
    ipcRenderer.invoke(findChannels.find, query, options),
  stop: () => ipcRenderer.invoke(findChannels.stop),
  close: () => ipcRenderer.invoke(findChannels.close),
  onFocus: (callback) => listen(findChannels.focus, callback),
  onStep: (callback) =>
    listen<[unknown]>(findChannels.step, (forward) =>
      callback(forward !== false),
    ),
  onClear: (callback) => listen(findChannels.clear, callback),
};
contextBridge.exposeInMainWorld("findBar", bridge);
