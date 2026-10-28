import { useEffect, useState, type ReactNode } from "react";
import {
  CircleCheck,
  Copy,
  Globe,
  Link2,
  SquareCode,
  Check,
} from "../ui/glyphs";
import { formatText, t, useT } from "../i18n";
import type { ArtifactEmbed } from "../../shared/sharing-api";
import { embedCode, embedDomainsOf } from "../../shared/sharing";
import "./publish-artifact-modal.css";
import { UsageNote, embedCodeState, copiedMs } from "./PublishArtifactModal";
import type {
  PublishContentState,
  PublishContentActions,
} from "./PublishArtifactModal";

/** The dialog's body for a state; `PublishArtifactModal` supplies state and actions. */
export function PublishArtifactContent({
  share,
  liveLinks,
  busy,
  copied,
  notice,
  title,
  usagePolicyUrl,
  onPublish,
  onCopy,
  onOpenLink,
  onUnpublish,
  onUsagePolicy,
  onEmbed,
  screenshotControl,
}: PublishContentState & PublishContentActions) {
  useT();
  let body: ReactNode;
  if (share) {
    const active = share.status === "active";
    body = (
      <>
        <div className="publish-artifact-card">
          <div className="publish-artifact-status">
            <Globe size={18} aria-hidden="true" />
            <div>
              {/* The published state. */}
              <h6>
                {active ? "Published (Public)" : "Removed by the administrator"}
              </h6>
              <p>
                {active
                  ? "Anyone on the web with the link can view the Artifact only. Your chat will remain private."
                  : "Your administrator removed this page. Its link no longer opens."}
              </p>
              {!active && share.disabledReason && (
                <p data-no-translate>
                  {formatText("Reason: {reason}", {
                    reason: share.disabledReason,
                  })}
                </p>
              )}
            </div>
          </div>
          {active && (
            <div className="publish-artifact-link">
              <a
                href={share.url}
                data-no-translate
                onClick={(event) => {
                  event.preventDefault();
                  onOpenLink();
                }}
              >
                {share.url}
              </a>
              <button
                type="button"
                className="publish-artifact-copy"
                onClick={onCopy}
              >
                {copied ? (
                  <CircleCheck size={16} aria-hidden="true" />
                ) : (
                  <Link2 size={16} aria-hidden="true" />
                )}
                {copied ? "Link copied" : "Copy public link"}
              </button>
            </div>
          )}
          {liveLinks > 1 && (
            <p className="publish-artifact-count" data-no-translate>
              {formatText(
                "{count} versions of this artifact have public links.",
                { count: liveLinks },
              )}
            </p>
          )}
        </div>
        <div className="button-row publish-artifact-unpublish">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={onUnpublish}
          >
            Unpublish
          </button>
          <p>
            Unpublishing removes the public link for every version of this
            artifact. Anyone with a link loses access, and the links can’t be
            restored.
          </p>
        </div>
        {active && onEmbed && (
          <div className="publish-artifact-embed-entry">
            <button type="button" onClick={onEmbed}>
              <SquareCode size={16} aria-hidden="true" />
              Get embed code
            </button>
          </div>
        )}
      </>
    );
  } else
    body = (
      <>
        <p className="publish-artifact-lead">
          Publishing this Artifact will make it accessible to anyone on the
          internet and potentially visible in search engine results. Your chat
          will remain private.
        </p>
        <div className="publish-artifact-card publish-artifact-title">
          {screenshotControl}
          <div data-no-translate>{title || t("Claudex Artifact")}</div>
        </div>
        <UsageNote url={usagePolicyUrl} onOpen={onUsagePolicy} />
        <div className="button-row publish-artifact-actions">
          <button
            type="button"
            className="primary"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={onPublish}
          >
            {busy ? "Publishing…" : "Publish & copy link"}
          </button>
        </div>
      </>
    );
  return (
    <div className="publish-artifact" aria-busy={busy || undefined}>
      {notice && (
        <div className="publish-artifact-notice" role="status">
          {notice}
        </div>
      )}
      {body}
    </div>
  );
}

/**
 * Get embed code: Allowed domains, saved when the field is left with a changed,
 * valid list ("Saved" then shows), the iframe code read-only, and Cancel (back
 * to the published link) and Copy code.
 */
export function EmbedSettings({
  shareId,
  title,
  onBack,
  onError,
}: {
  shareId: string;
  title: string;
  onBack: () => void;
  onError: (error: unknown) => void;
}) {
  useT();
  const [embed, setEmbed] = useState<ArtifactEmbed>();
  const [text, setText] = useState("");
  const [saved, setSaved] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [didSave, setDidSave] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    window.desktop
      .artifactEmbed(shareId)
      .then((next) => {
        if (!live) return;
        setEmbed(next);
        setText(next.domains.join(", "));
        setSaved(next.domains);
      })
      .catch((error) => {
        if (!live) return;
        onError(error);
        onBack();
      });
    return () => {
      live = false;
    };
  }, [shareId]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), copiedMs);
    return () => clearTimeout(timer);
  }, [copied]);
  const { error } = embedCodeState(text, saved, editing);
  const code = embed ? embedCode(embed.url, title) : "";
  const leave = () => {
    setEditing(false);
    if (!embed || !embedCodeState(text, saved, false).save) return;
    const domains = embedDomainsOf(text);
    window.desktop
      .setArtifactEmbedDomains(shareId, domains)
      .then((next) => {
        setSaved(next.domains);
        setDidSave(true);
      })
      .catch(onError);
  };
  return (
    <div className="publish-artifact publish-artifact-embed">
      <div className="publish-artifact-field">
        <label htmlFor="publish-embed-domains">Allowed domains</label>
        <p id="publish-embed-domains-note">
          Only these domains can embed this artifact. Separate with commas.
        </p>
        <textarea
          id="publish-embed-domains"
          rows={1}
          value={text}
          disabled={!embed}
          placeholder="www.example.com, www.myblog.com"
          aria-describedby={
            error
              ? "publish-embed-domains-note publish-embed-domains-error"
              : "publish-embed-domains-note"
          }
          aria-invalid={error ? true : undefined}
          data-no-translate
          onChange={(event) => {
            setText(event.target.value);
            setEditing(true);
            setDidSave(false);
          }}
          onBlur={leave}
        />
        {error && (
          <p
            id="publish-embed-domains-error"
            className="publish-artifact-field-error"
            role="alert"
            data-no-translate
          >
            {error}
          </p>
        )}
      </div>
      <div className="publish-artifact-field">
        <label htmlFor="publish-embed-code">Embed code</label>
        <textarea
          id="publish-embed-code"
          rows={5}
          value={code}
          readOnly
          data-no-translate
        />
      </div>
      <div className="button-row publish-artifact-embed-actions">
        {didSave && (
          <span className="publish-artifact-saved" role="status">
            <Check size={16} aria-hidden="true" />
            Saved
          </span>
        )}
        <button type="button" className="secondary" onClick={onBack}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={!code}
          onClick={() =>
            void window.desktop
              .copyText(code)
              .then(() => setCopied(true))
              .catch(onError)
          }
        >
          {copied ? (
            <CircleCheck size={16} aria-hidden="true" />
          ) : (
            <Copy size={16} aria-hidden="true" />
          )}
          Copy code
        </button>
      </div>
    </div>
  );
}
