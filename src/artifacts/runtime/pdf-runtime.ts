/**
 * Runs inside the sandboxed preview frame (bundled as `ClaudexPdf`). pdf.js
 * runs on the frame's main thread: the preview allows no workers, network
 * or eval.
 */
import * as pdfjs from "pdfjs-dist";
// @ts-expect-error The worker module ships without type declarations.
import * as worker from "pdfjs-dist/build/pdf.worker.mjs";

import cmaps from "claudex:pdf-cmaps";

(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = worker;
const maxPages = 200;

/**
 * Serves pdf.js's predefined CMaps from the inlined copies, so text in a
 * Chinese, Japanese or Korean font the PDF does not embed can be decoded
 * (the frame has no network to fetch them).
 */
class InlineBinaryData {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    const data = kind === "cMapUrl" ? cmaps[filename] : undefined;
    if (data === undefined)
      throw new Error(`The preview has no built-in ${filename}.`);
    const text = atob(data);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes;
  }
}
const report = (message: unknown) =>
  (
    window as unknown as { __claudexReportError?: (m: unknown) => void }
  ).__claudexReportError?.(
    message instanceof Error ? message.message : message,
  );

export async function render(base64: string, container: HTMLElement) {
  try {
    const text = atob(base64);
    const data = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) data[i] = text.charCodeAt(i);
    const pdf = await pdfjs.getDocument({
      data,
      useWorkerFetch: false,
      // Only a base name the factory recognises; nothing is fetched.
      cMapUrl: "inline/",
      cMapPacked: true,
      BinaryDataFactory: InlineBinaryData,
    }).promise;
    const scale = Math.min(2, window.devicePixelRatio || 1) * 1.25;
    for (let n = 1; n <= Math.min(pdf.numPages, maxPages); n++) {
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / (scale / 1.25))}px`;
      canvas.setAttribute("aria-label", `Page ${n}`);
      container.append(canvas);
      await page.render({ canvas, viewport }).promise;
    }
  } catch (error) {
    report(error);
  }
}
