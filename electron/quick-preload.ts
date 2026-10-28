/**
 * The Quick Entry composer's preload (shared/quick-entry.ts). It exposes
 * only the composer's own calls as `window.quickEntry`, never the app's
 * bridge: the page can submit its prompt, put itself away and report its
 * height, and hears when it is brought up.
 */
import { contextBridge, ipcRenderer } from "electron";
import {
  quickEntryChannels,
  type QuickEntryBridge,
} from "../shared/quick-entry";

const bridge: QuickEntryBridge = {
  ready: () => ipcRenderer.send(quickEntryChannels.ready),
  voice: {
    requestMicrophone: () =>
      ipcRenderer.invoke(quickEntryChannels.voice, "requestMicrophone"),
    startDictation: () =>
      ipcRenderer.invoke(quickEntryChannels.voice, "startDictation"),
    dictationAudio: (id, pcm) =>
      ipcRenderer.invoke(quickEntryChannels.voice, "dictationAudio", id, pcm),
    finishDictation: (id) =>
      ipcRenderer.invoke(quickEntryChannels.voice, "finishDictation", id),
    cancelDictation: (id) =>
      ipcRenderer.invoke(quickEntryChannels.voice, "cancelDictation", id),
  },
  onDictation: (callback) => {
    const listener = (_event: unknown, action: "start" | "stop" | "toggle") =>
      callback(action);
    ipcRenderer.on(quickEntryChannels.dictation, listener);
    return () =>
      void ipcRenderer.removeListener(quickEntryChannels.dictation, listener);
  },
  onHidden: (callback) => {
    const listener = () => callback();
    ipcRenderer.on(quickEntryChannels.hidden, listener);
    return () =>
      void ipcRenderer.removeListener(quickEntryChannels.hidden, listener);
  },
  submit: (text, images) =>
    images?.length
      ? ipcRenderer.invoke(quickEntryChannels.submitImages, text, images)
      : ipcRenderer.send(quickEntryChannels.submit, text),
  dismiss: () => ipcRenderer.send(quickEntryChannels.dismiss),
  resize: (height) => ipcRenderer.send(quickEntryChannels.resize, height),
  onShown: (callback) => {
    const listener = (_event: unknown, height: number) => callback(height);
    ipcRenderer.on(quickEntryChannels.shown, listener);
    return () =>
      void ipcRenderer.removeListener(quickEntryChannels.shown, listener);
  },
};
contextBridge.exposeInMainWorld("quickEntry", bridge);
