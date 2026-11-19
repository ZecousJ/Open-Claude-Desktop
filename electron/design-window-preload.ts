import { contextBridge, ipcRenderer } from "electron";
import {
  designWindowArgument,
  designWindowChannels,
  type DesignWindowBridge,
} from "../shared/design-window";

const args = process.argv.find((arg) => arg.startsWith(designWindowArgument));
if (args && process.isMainFrame) {
  const bridge: DesignWindowBridge = {
    context: JSON.parse(args.slice(designWindowArgument.length)),
    currentConversation: () =>
      ipcRenderer.invoke(designWindowChannels.currentConversation),
    onConversation: (listener) => {
      const receive = (
        _event: unknown,
        conversation: Parameters<typeof listener>[0],
      ) => listener(conversation);
      ipcRenderer.on(designWindowChannels.conversation, receive);
      return () => {
        ipcRenderer.removeListener(designWindowChannels.conversation, receive);
      };
    },
    read: () => ipcRenderer.invoke(designWindowChannels.read),
    save: ({ content, expectedRevision }) =>
      ipcRenderer.invoke(designWindowChannels.save, content, expectedRevision),
  };
  contextBridge.exposeInMainWorld("designWindow", bridge);
}
