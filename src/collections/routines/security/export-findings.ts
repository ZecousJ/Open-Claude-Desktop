import { type SecurityFinding } from "../../../../shared/security-review";
import {
  exportFilename,
  findingsCsv,
  findingsMarkdown,
  type ExportContext,
} from "../../../../shared/security-review-export";

/** The three ways out of the Export menu (the original's: copy as Markdown, download Markdown, download CSV). */
export type ExportKind = "copy-md" | "download-md" | "download-csv";

/** Copies text with the app's clipboard, else the page's. */
async function copy(text: string) {
  const desktop = typeof window === "undefined" ? undefined : window.desktop;
  if (desktop?.copyText) await desktop.copyText(text);
  else await navigator.clipboard.writeText(text);
}

/**
 * Exports findings (the list as shown, or one finding). Resolves to
 * "copied" or "saved", or "cancelled" when the save dialog was closed.
 */
export async function exportFindings(
  kind: ExportKind,
  findings: SecurityFinding[],
  context: ExportContext,
  single?: SecurityFinding,
): Promise<"copied" | "saved" | "cancelled"> {
  const markdown = () => findingsMarkdown(findings, context);
  if (kind === "copy-md") {
    await copy(markdown());
    return "copied";
  }
  const base = exportFilename(context.routine, Date.now(), single);
  const saved =
    kind === "download-md"
      ? await window.desktop.saveArtifact(`${base}.md`, markdown())
      : await window.desktop.saveArtifact(
          `${base}.csv`,
          findingsCsv(findings, context),
        );
  return saved === null ? "cancelled" : "saved";
}
