import { printDocument } from "../../shared/artifact-document";

export async function browserDocumentPdf(title: string, html: string) {
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.setAttribute("sandbox", "allow-same-origin allow-modals");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Unable to print document")),
        60000,
      );
      frame.onload = () => resolve();
      frame.onerror = () => reject(new Error("Unable to print document"));
      frame.srcdoc = printDocument(title, html);
      document.body.append(frame);
    });
    clearTimeout(timer);
    const printer = frame.contentWindow;
    if (!printer) throw new Error("Unable to print document");
    printer.focus();
    await new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 5 * 60_000);
      printer.addEventListener(
        "afterprint",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      printer.print();
    });
    return null;
  } finally {
    clearTimeout(timer);
    frame.remove();
  }
}
