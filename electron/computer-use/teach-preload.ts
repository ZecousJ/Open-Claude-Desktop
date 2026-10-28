import { contextBridge, ipcRenderer } from "electron";
import type { ComputerUseTeachStep } from "../../shared/computer-use";

const listen = <Payload>(
  name: string,
  callback: (payload: Payload) => void,
) => {
  ipcRenderer.on(`cu-teach:${name}`, (_event, payload: Payload) =>
    callback(payload),
  );
};

contextBridge.exposeInMainWorld("cuTeach", {
  next: () => ipcRenderer.send("cu-teach:next"),
  exit: () => ipcRenderer.send("cu-teach:exit"),
  mouseEnter: () => ipcRenderer.send("cu-teach:enter"),
  mouseLeave: () => ipcRenderer.send("cu-teach:leave"),
  onShow: (callback: (step: ComputerUseTeachStep) => void) =>
    listen("show", callback),
  onWorking: (callback: () => void) => listen("working", callback),
  onHide: (callback: () => void) => listen("hide", callback),
  onReassertHover: (callback: () => void) => listen("hover", callback),
});
