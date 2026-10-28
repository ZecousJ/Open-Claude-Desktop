import { designPdfFilename } from "./design-pdf";

export type DocumentCloud = "gdrive" | "notion";

export interface DocumentConnector {
  server: string;
  service: DocumentCloud;
}

export interface DocumentCloudSave extends DocumentConnector {
  title: string;
  markdown: string;
}

export const documentCloudLabels = {
  gdrive: "Google Docs",
  notion: "Notion",
} as const;

export function documentFilename(title: string, extension: string) {
  const name = designPdfFilename(
    title.replace(/\.(?:docx|pptx|pdf|md|markdown)$/i, ""),
  );
  return `${name.slice(0, -4)}.${extension}`;
}

export function printDocument(title: string, html: string) {
  const safeTitle = title.replace(
    /[&<>"']/g,
    (character) => `&#${character.charCodeAt(0)};`,
  );
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${safeTitle}</title></head><body>${html}</body></html>`;
}
