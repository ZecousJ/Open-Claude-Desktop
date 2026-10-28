import { dialog, BrowserWindow, type WebFrameMain } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  designPdfChannel,
  designPdfFilename,
  designPdfInput,
  type DesignPdfResult,
} from "../../shared/design-pdf";
import {
  documentFilename,
  printDocument,
} from "../../shared/artifact-document";

export async function saveDocumentPdf(
  owner: BrowserWindow,
  title: string,
  html: string,
) {
  if (activeExports) throw new Error("Unable to export document.");
  activeExports++;
  let printer: BrowserWindow | undefined;
  let temporary: string | undefined;
  try {
    const result = await dialog.showSaveDialog(owner, {
      defaultPath: documentFilename(title, "pdf"),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (result.canceled || !result.filePath) return null;
    printer = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: false,
        partition: "artifact-document-print",
      },
    });
    printer.webContents.on("will-navigate", (event) => event.preventDefault());
    printer.webContents.session.webRequest.onBeforeRequest(
      (request, callback) =>
        callback({ cancel: !request.url.startsWith("data:") }),
    );
    printer.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    await bounded(
      printer.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(printDocument(title, html))}`,
      ),
    );
    const data = await bounded(
      printer.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
        generateTaggedPDF: true,
        pageSize: "Letter",
      }),
    );
    const directory = await fs.realpath(path.dirname(result.filePath));
    temporary = path.join(directory, `.claudex-pdf-${randomUUID()}`);
    await fs.writeFile(temporary, data, {
      flag: "wx",
      mode: 0o600,
      signal: AbortSignal.timeout(60000),
    });
    await fs.rename(
      temporary,
      path.join(directory, path.basename(result.filePath)),
    );
    temporary = undefined;
    return result.filePath;
  } finally {
    if (printer && !printer.isDestroyed()) printer.destroy();
    if (temporary) await fs.unlink(temporary).catch(() => {});
    activeExports--;
  }
}

let activeExports = 0;
async function bounded<T>(operation: Promise<T>) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), 60000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

// .
export function attachDesignPdf(
  window: BrowserWindow,
  chromeUrl: string,
  frameUrl: string,
) {
  window.webContents.ipc.handle(
    designPdfChannel,
    async (event, raw: unknown): Promise<DesignPdfResult> => {
      const request = designPdfInput(raw);
      const contents = window.webContents;
      const trustedSender =
        event.senderFrame === contents.mainFrame &&
        event.senderFrame.url.split("#")[0] === chromeUrl;
      const expected = new URL(frameUrl);
      if (!trustedSender || !request || window.isDestroyed())
        return { ok: false, error: "refused request" };
      if (
        request.origin !== `${expected.protocol}//${expected.host}` ||
        expected.hash !== `#${request.nonce}`
      )
        return { ok: false, error: "refused origin" };
      if (activeExports)
        return { ok: false, error: "export already in progress" };
      activeExports++;
      let temporary: string | undefined;
      let phase = "select";
      try {
        const matches = contents.mainFrame.framesInSubtree.filter(
          (frame) => frame.url === frameUrl,
        );
        if (matches.length !== 1)
          return { ok: false, error: "no unique print frame" };
        const frame: WebFrameMain = matches[0];
        phase = "dialog";
        const result = await dialog.showSaveDialog(window, {
          defaultPath: designPdfFilename(request.docTitle),
          filters: [{ name: "PDF", extensions: ["pdf"] }],
        });
        if (result.canceled || !result.filePath)
          return { ok: false, canceled: true };
        const stillBound = () =>
          !window.isDestroyed() &&
          !frame.isDestroyed() &&
          frame.url === frameUrl;
        phase = "resolve";
        const directory = await bounded(
          fs.realpath(path.dirname(result.filePath)),
        );
        if (!stillBound()) return { ok: false, error: "frame gone" };
        phase = "render";
        const data = await bounded(
          frame.printToPDF({
            printBackground: true,
            preferCSSPageSize: true,
            generateTaggedPDF: true,
            pageSize: request.paper
              ? {
                  width: request.paper.widthPx / 96,
                  height: request.paper.heightPx / 96,
                }
              : "Letter",
          }),
        );
        if (!stillBound()) return { ok: false, error: "render failed" };
        phase = "write";
        temporary = path.join(directory, `.claudex-pdf-${randomUUID()}`);
        await fs.writeFile(temporary, data, {
          flag: "wx",
          mode: 0o600,
          signal: AbortSignal.timeout(60000),
        });
        await bounded(
          fs.rename(
            temporary,
            path.join(directory, path.basename(result.filePath)),
          ),
        );
        temporary = undefined;
        return { ok: true };
      } catch {
        return { ok: false, error: `${phase} failed` };
      } finally {
        activeExports--;
        if (temporary) await fs.unlink(temporary).catch(() => {});
      }
    },
  );
}
