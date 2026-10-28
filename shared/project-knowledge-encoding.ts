/**
 * O16 140–153. The person verifies a 500-character preview before explicitly
 * accepting replacement decoding.
 */
export const knowledgeEncodings = [
  ["utf-8", "Default (UTF-8)"],
  ["windows-1252", "Western European (Windows-1252)"],
  ["windows-1250", "Central European (Windows-1250)"],
  ["windows-1251", "Cyrillic (Windows-1251)"],
  ["iso-8859-1", "Latin-1 (ISO-8859-1)"],
  ["shift_jis", "Japanese (Shift_JIS)"],
  ["gb18030", "Chinese (GB18030)"],
  ["euc-kr", "Korean (EUC-KR)"],
  ["windows-1256", "Arabic (Windows-1256)"],
  ["windows-1254", "Turkish (Windows-1254)"],
  ["windows-1253", "Greek (Windows-1253)"],
  ["tis-620", "Thai (TIS-620)"],
] as const;
export const knowledgeDocumentExtensions = ["docx", "pptx", "xlsx"] as const;
export const knowledgeEncodingPreviewChars = 500;
export function checkedKnowledgeEncoding(encoding: string): string {
  if (!knowledgeEncodings.some(([value]) => value === encoding))
    throw new Error("Choose a supported file encoding.");
  return encoding;
}
