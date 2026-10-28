import type { GeneratedFile } from "../../shared/types";
import type { Artifact } from "../ui/components";
import { DownloadAllButton, GeneratedFileCard } from "./GeneratedFileCard";
import "./generated-file-card.css";

/**
 * The file cards under a finished change and, for two or more files, Download
 * all. Loaded on first use, with its styles, so the web app's first load stays
 * within budget.
 */
export default function GeneratedFileCards({
  files,
  all,
  platform,
  onArtifact,
  onError,
  onNotify,
}: {
  /** Files that get a card (not the HTML and SVG artifacts). */
  files: GeneratedFile[];
  /** Every file Download all saves, artifacts included. */
  all: GeneratedFile[];
  platform?: string;
  onArtifact: (artifact: Artifact) => void;
  onError?: (error: unknown) => void;
  onNotify?: (message: string) => void;
}) {
  return (
    <>
      {files.map((file) => (
        <GeneratedFileCard
          key={file.id}
          file={file}
          platform={platform}
          onArtifact={onArtifact}
          onError={onError}
          onNotify={onNotify}
        />
      ))}
      {all.length > 1 && (
        <DownloadAllButton files={all} onError={onError} onNotify={onNotify} />
      )}
    </>
  );
}
