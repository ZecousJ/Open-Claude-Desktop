import { useId, useState } from "react";
import { Database } from "../ui/glyphs";
import {
  artifactDataSize,
  artifactStorageLines,
  type ArtifactDataUsage,
} from "../../shared/artifact-data";
import { ArtifactSubmenu } from "./ArtifactExportMenu";
import { currentLocale, formatText, t } from "../i18n";

/** Storage figures and notices. */
export function ArtifactStorageMenu({
  usage,
  onRequestLimit,
  onError,
}: {
  usage: ArtifactDataUsage;
  onRequestLimit: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const description = useId();
  const header = useId();
  const [requesting, setRequesting] = useState(false);
  const lines = artifactStorageLines(usage).map((line) => ({
    ...line,
    label: t(
      line.resource === "files"
        ? "File storage limit"
        : "Database storage limit",
    ),
    figure: formatText("{used} of {limit}", {
      used: artifactDataSize(line.bytes, currentLocale()),
      limit: artifactDataSize(line.maxBytes, currentLocale()),
    }),
    sentence: line.low
      ? t(
          line.atDocumentCap
            ? "New data isn’t being saved. Ask Claudex to optimize data storage."
            : line.full
              ? line.resource === "files"
                ? "There’s no room left for new files. Ask Claudex to free up storage."
                : "New data isn’t being saved. Ask Claudex to free up storage."
              : "Ask Claudex to free up storage.",
        )
      : null,
  }));
  const request = lines.some((line) => line.low) && usage.canRequestLimit;
  return (
    <ArtifactSubmenu
      label={t("Storage")}
      icon={<Database size={15} />}
      storage
      describedBy={description}
      hint={artifactDataSize(usage.bytes, currentLocale())}
      testId="frame-title-menu-storage"
      trailing={
        <span id={description} hidden>
          {lines
            .flatMap((line) => [
              formatText("{label}: {figure}.", {
                label: line.label,
                figure: line.figure,
              }),
              ...(line.sentence ? [line.sentence] : []),
            ])
            .join(" ")}
        </span>
      }
      header={
        <>
          <div
            id={header}
            className="artifact-storage-lines"
            data-testid="frame-title-menu-storage-lines"
          >
            {lines.map((line) => (
              <div key={line.resource} data-storage-line={line.resource}>
                <div className="artifact-storage-figure">
                  <span>{line.label}</span>
                  <span>{line.figure}</span>
                </div>
                {line.sentence && <span>{line.sentence}</span>}
              </div>
            ))}
          </div>
          {request && <div role="separator" />}
        </>
      }
      items={
        request
          ? [
              {
                key: "limit",
                label: t("Request a higher limit"),
                disabled: requesting,
                testId: "frame-title-menu-storage-limit",
                describedBy: header,
                onSelect: () => {
                  setRequesting(true);
                  void onRequestLimit()
                    .catch(onError)
                    .finally(() => setRequesting(false));
                },
              },
            ]
          : []
      }
    />
  );
}
