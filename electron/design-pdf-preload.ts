import { contextBridge, ipcRenderer } from "electron";
import {
  designBridgeOrigin,
  designPdfChannel,
  type DesignPdfBridge,
} from "../shared/design-pdf";

const localDocument = process.argv
  .find((arg) => arg.startsWith("--claudex-design-document="))
  ?.slice("--claudex-design-document=".length);
if (
  process.isMainFrame &&
  designBridgeOrigin(window.location.href, localDocument)
) {
  const bridge: DesignPdfBridge = {
    printFrameToPdf: (request) => {
      try {
        return ipcRenderer
          .invoke(designPdfChannel, {
            origin: request.origin,
            nonce: request.nonce,
            docTitle: request.docTitle,
            paper: request.paper,
          })
          .catch(() => ({ ok: false, error: "refused" }));
      } catch {
        return Promise.resolve({ ok: false, error: "refused" });
      }
    },
  };
  contextBridge.exposeInMainWorld("omeletteDesktopPdf", bridge);
}
