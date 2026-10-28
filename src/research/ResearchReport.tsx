import { useEffect, useState } from "react";
import { t } from "../i18n";
import { Markdown } from "../ui/Markdown";
import type { Artifact } from "../ui/ArtifactTypes";

export function ResearchReport({
  conversationId,
  turnId,
  onArtifact,
}: {
  conversationId: string;
  turnId: string;
  onArtifact: (artifact: Artifact) => void;
}) {
  const [report, setReport] = useState<{ markdown: string }>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    setReport(undefined);
    setFailed(false);
    window.desktop.readResearchReport(conversationId, turnId).then(
      (value) => {
        if (current) setReport(value);
      },
      () => {
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [conversationId, turnId]);
  if (failed)
    return <p role="alert">{t("This research report isn't available.")}</p>;
  if (!report) return <p role="status">{t("Loading the report…")}</p>;
  return (
    <div className="markdown prose" data-cds="Prose">
      <Markdown text={report.markdown} onArtifact={onArtifact} />
    </div>
  );
}
