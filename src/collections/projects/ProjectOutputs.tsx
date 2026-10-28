import { useMemo } from "react";
import { File, Pin, PinFilled } from "../../ui/glyphs";
import type { Conversation } from "../../../shared/types";
import type { Artifact } from "../../ui/ArtifactTypes";
import { collectArtifacts } from "../../artifacts/artifact-collection";
import { artifactIdentity } from "../../artifacts/artifact-metadata";
import { openArtifact, pinArtifact } from "../../app/ArtifactHost";
import { useApp } from "../../app/AppContext";
import { RelativeTime } from "../../ui/RelativeTime";
import { t } from "../../i18n";
import "./project-outputs.css";

export function splitProjectOutputs(
  artifacts: Artifact[],
  chats: Conversation[],
) {
  const times = new Map(chats.map((chat) => [chat.id, chat.updatedAt]));
  const rows = artifacts
    .filter(
      (artifact) =>
        artifact.conversationId && times.has(artifact.conversationId),
    )
    .sort(
      (left, right) =>
        (right.updatedAt ?? times.get(right.conversationId!) ?? 0) -
        (left.updatedAt ?? times.get(left.conversationId!) ?? 0),
    );
  return {
    pinned: rows.filter((row) => row.pinned),
    others: rows.filter((row) => !row.pinned),
  };
}

/** Project outputs home, separate from the global Artifacts gallery. */
export function ProjectOutputs({ chats }: { chats: Conversation[] }) {
  const app = useApp();
  const { artifactShares, artifactLibrary } = app.snapshot;
  const sections = useMemo(
    () =>
      splitProjectOutputs(
        collectArtifacts(chats, artifactShares ?? [], artifactLibrary),
        chats,
      ),
    [chats, artifactShares, artifactLibrary],
  );
  const row = (artifact: Artifact) => {
    const chat = chats.find((chat) => chat.id === artifact.conversationId);
    return (
      <li key={artifactIdentity(artifact)} data-testid="project-output-row">
        <button
          type="button"
          className="project-output-open"
          onClick={() => openArtifact(app, artifact)}
        >
          <File size={16} aria-hidden="true" />
          <span className="project-output-text">
            <bdi>{artifact.filename ?? artifact.name}</bdi>
            <span>
              {t(artifact.surface === "file" ? "File" : "Artifact")}
              {chat && (
                <>
                  {" "}
                  · <bdi>{chat.title}</bdi> ·{" "}
                  <RelativeTime
                    createdAt={artifact.updatedAt ?? chat.updatedAt}
                  />
                </>
              )}
            </span>
          </span>
        </button>
        <button
          type="button"
          className="project-output-pin"
          aria-label={t(artifact.pinned ? "Unpin" : "Pin")}
          aria-pressed={Boolean(artifact.pinned)}
          onClick={() => void pinArtifact(app, artifact).catch(app.report)}
        >
          {artifact.pinned ? <PinFilled size={16} /> : <Pin size={16} />}
        </button>
      </li>
    );
  };
  if (!sections.pinned.length && !sections.others.length) return null;
  return (
    <div className="project-outputs-home" data-testid="project-outputs-home">
      {sections.pinned.length > 0 && (
        <section>
          <div className="project-outputs-heading">
            <h3>{t("Pinned")}</h3>
          </div>
          <ul>{sections.pinned.map(row)}</ul>
        </section>
      )}
      {sections.others.length > 0 && (
        <section>
          <div className="project-outputs-heading">
            <h3>{t("All outputs")}</h3>
            <span>{t("Newest first")}</span>
          </div>
          <ul>{sections.others.map(row)}</ul>
        </section>
      )}
    </div>
  );
}
