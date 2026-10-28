export interface DesignPdfRequest {
  origin: string;
  nonce: string;
  docTitle: string;
  paper?: { widthPx: number; heightPx: number };
}
export type DesignPdfResult =
  { ok: true } | { ok: false; canceled?: boolean; error?: string };
export interface DesignPdfBridge {
  printFrameToPdf(request: DesignPdfRequest): Promise<DesignPdfResult>;
}
export const designPdfChannel = "claudex:design-pdf";

// .
export function designBridgeOrigin(url: string, localDocument?: string) {
  try {
    const value = new URL(url);
    value.hash = "";
    if (localDocument && value.href === localDocument) return true;
    return (
      value.hostname === "localhost" ||
      value.hostname === "127.0.0.1" ||
      (value.protocol === "https:" &&
        ([
          "https://claude.ai",
          "https://preview.claude.ai",
          "https://claude.com",
          "https://preview.claude.com",
        ].includes(value.origin) ||
          value.origin.endsWith(".ant.dev")))
    );
  } catch {
    return false;
  }
}

export function designPdfInput(value: unknown): DesignPdfRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  if (
    typeof input.origin !== "string" ||
    input.origin.length > 512 ||
    typeof input.nonce !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      input.nonce,
    ) ||
    typeof input.docTitle !== "string" ||
    input.docTitle.length > 4096
  )
    return;
  const paper = input.paper as
    { widthPx?: unknown; heightPx?: unknown } | undefined;
  return {
    origin: input.origin,
    nonce: input.nonce,
    docTitle: input.docTitle,
    ...(paper &&
    typeof paper.widthPx === "number" &&
    typeof paper.heightPx === "number" &&
    Number.isFinite(paper.widthPx) &&
    Number.isFinite(paper.heightPx) &&
    paper.widthPx > 0 &&
    paper.heightPx > 0 &&
    paper.widthPx <= 20000 &&
    paper.heightPx <= 20000
      ? { paper: { widthPx: paper.widthPx, heightPx: paper.heightPx } }
      : {}),
  };
}

export function designPdfFilename(title: string) {
  const base =
    title
      .normalize("NFC")
      .replace(/\p{Cf}/gu, "")
      .split(/[\\/]/)
      .at(-1) ?? "";
  const name = Array.from(
    base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, " ").trim(),
  )
    .slice(0, 120)
    .join("")
    .replace(/[.\s]+$/u, "");
  return `${!name || /^(?:CON|PRN|AUX|NUL|(?:COM|LPT)[1-9¹²³])(?:\.|$)/iu.test(name) ? "document" : name}.pdf`;
}
