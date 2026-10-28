import { Suspense, useState } from "react";
import { lazyPiece } from "../../ui/lazy-piece";
import type { SharedChatContent } from "../../../shared/sharing-api";
import { api } from "../../desktop-api";
import { ArtifactPreview } from "../../artifacts/ArtifactPreview";
import { t } from "../../i18n";
const ArtifactEditAccess = lazyPiece(() => import("./ArtifactEditAccess"));

export function SharedArtifactEditor({
  token,
  chat,
  onChanged,
  onError,
}: {
  token: string;
  chat: SharedChatContent;
  onChanged: (chat: SharedChatContent) => void;
  onError: (error: unknown) => void;
}) {
  const artifact = chat.artifacts?.[0];
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(artifact?.content ?? "");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  if (!artifact) return null;
  async function save(patch: { content?: string; comment?: string }) {
    if (busy) return;
    setBusy(true);
    try {
      await api.editSharedArtifact(token, patch);
      onChanged(await api.readSharedChat(token));
      setEditing(false);
      setComment("");
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="publish-artifact">
      {editing && chat.canEdit !== false ? (
        <>
          <textarea
            aria-label={t("Code")}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={16}
          />
          <div className="publish-artifact-link">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              {t("Cancel")}
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void save({ content })}
            >
              {t("Save")}
            </button>
          </div>
        </>
      ) : (
        <>
          <ArtifactPreview
            artifact={{
              id: token,
              name: artifact.title,
              language: artifact.language,
              content: artifact.content,
            }}
            refresh={chat.snapshotAt}
            onError={onError}
            onDownload={() => {
              const link = document.createElement("a");
              link.href = URL.createObjectURL(
                new Blob([artifact.content], { type: "text/plain" }),
              );
              link.download = artifact.title;
              link.click();
              setTimeout(() => URL.revokeObjectURL(link.href), 1000);
            }}
          />
          {chat.canEdit !== false && (
            <button
              className="secondary"
              onClick={() => {
                setContent(artifact.content);
                setEditing(true);
              }}
            >
              {t("Edit")}
            </button>
          )}
        </>
      )}
      <Suspense fallback={null}>
        <ArtifactEditAccess
          token={token}
          chat={chat}
          onChanged={onChanged}
          onError={onError}
        />
      </Suspense>
      {(chat.canComment ?? chat.canEdit) === true && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save({ comment });
          }}
        >
          <textarea
            aria-label={t("Add a comment")}
            placeholder={t("Add a comment")}
            value={comment}
            maxLength={4000}
            onChange={(event) => setComment(event.target.value)}
          />
          <button className="primary" disabled={busy || !comment.trim()}>
            {t("Comment")}
          </button>
        </form>
      )}
    </section>
  );
}
