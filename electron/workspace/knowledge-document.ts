import path from "node:path";
import { knowledgeFileLimit } from "../../shared/collections-api";
import { completeDocumentTextData } from "./document-text";
import {
  convertOfficeDocument,
  normalizedOfficeExtension,
  OfficeRuntimeUnavailable,
} from "./office-conversion";

const directFormats = new Set(["docx", "pptx", "xlsx", "pdf", "epub"]);

export class KnowledgeDocumentError extends Error {
  constructor(
    readonly kind:
      | "invalid_text"
      | "invalid_file_type"
      | "extraction_failed"
      | "file_too_large",
    message: string,
  ) {
    super(message);
  }
}

export async function extractKnowledgeDocument({
  data,
  name,
  mediaType,
  runtime,
  signal,
}: {
  data: Buffer;
  name: string;
  mediaType: string;
  runtime?: string;
  signal: AbortSignal;
}) {
  const extension = path.extname(name).slice(1).toLowerCase();
  const normalized = normalizedOfficeExtension(extension);
  let text: string;
  if (normalized || directFormats.has(extension)) {
    if (normalized && !runtime)
      throw new OfficeRuntimeUnavailable(
        "Document conversion is unavailable on this host.",
      );
    try {
      const document =
        normalized && runtime
          ? await convertOfficeDocument({
              runtime,
              data,
              extension,
              output: normalized,
              signal,
            })
          : data;
      text = await completeDocumentTextData(
        document,
        normalized ?? extension,
        signal,
      );
    } catch (error) {
      if (error instanceof OfficeRuntimeUnavailable) throw error;
      signal.throwIfAborted();
      throw new KnowledgeDocumentError(
        "extraction_failed",
        "The document could not be read. It may be damaged or password protected.",
      );
    }
  } else if (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType === "application/xml"
  ) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      throw new KnowledgeDocumentError(
        "invalid_text",
        "The document is not valid UTF-8 text.",
      );
    }
    if (text.includes("\0"))
      throw new KnowledgeDocumentError(
        "invalid_text",
        "Binary content is not a text document.",
      );
  } else {
    throw new KnowledgeDocumentError(
      "invalid_file_type",
      "Document text extraction is unavailable for this file type.",
    );
  }
  signal.throwIfAborted();
  if (!text.trim())
    throw new KnowledgeDocumentError(
      "extraction_failed",
      "The document has no readable text.",
    );
  if (Buffer.byteLength(text) > knowledgeFileLimit)
    throw new KnowledgeDocumentError(
      "file_too_large",
      "The extracted document text is too large.",
    );
  return text;
}
