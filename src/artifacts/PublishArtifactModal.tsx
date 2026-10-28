import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { lazyPiece } from "../ui/lazy-piece";
import { createPortal } from "react-dom";
import { Camera, Info, X } from "../ui/glyphs";
import { Modal } from "../ui/Controls";
import { formatText, t } from "../i18n";
import type { ArtifactShareInput } from "../../shared/types";
import type {
  ArtifactPublication,
  HostedShare,
} from "../../shared/sharing-api";
import { embedDomainsOf, invalidEmbedDomains } from "../../shared/sharing";
import "./publish-artifact-modal.css";
import {
  PublishArtifactContent,
  EmbedSettings,
} from "./PublishArtifactContent";
const ArtifactEditRequests = lazyPiece(() => import("./ArtifactEditRequests"));

/**
 * Publish artifact. Before publishing: what publishing means, the artifact's
 * title, the usage note and "Publish & copy link". Published: the public link
 * of this version with Copy link, how many versions have links, and Unpublish,
 * which removes every version's link and closes the dialog. Each version
 * published keeps a link of its own on the Claudex service
 * (electron/hosted-shares.ts). A published version also offers Get embed code
 * when the service serves embeds: the allowed domains and the iframe code.
 * Screenshots are uploaded with the published version's snapshot.
 */

/** Where the dialog was opened: the file panel keeps "Publish artifact" as its title. */
export type PublishSurface = "artifact" | "file";

/** The dialog's title. */
export function publishTitle(published: boolean, surface: PublishSurface) {
  return published && surface === "artifact"
    ? "Artifact published"
    : "Publish artifact";
}

export interface PublishContentState {
  /** The version's link: active, taken down, or none. */
  share: HostedShare | null;
  liveLinks: number;
  busy: boolean;
  /** Copy link was just used: it reads Link copied. */
  copied: boolean;
  /** The link stopped while the dialog was open (5 s banner). */
  notice?: string;
  title: string;
  usagePolicyUrl?: string;
  screenshotControl?: ReactNode;
}

export interface PublishContentActions {
  onPublish: () => void;
  onCopy: () => void;
  onOpenLink: () => void;
  onUnpublish: () => void;
  onUsagePolicy: (url: string) => void;
  /** Get embed code; absent where the service serves no embeds. */
  onEmbed?: () => void;
}

/** The usage note before publishing, with the administrator's policy when there is one. */
export function UsageNote({
  url,
  onOpen,
}: {
  url?: string;
  onOpen: (url: string) => void;
}) {
  const lead = url
    ? t(
        "The {policy} prohibits use of Claudex for harmful use cases like producing violent, abusive, or deceptive content.",
      )
    : "";
  const [before, after = ""] = lead.split("{policy}");
  return (
    <div className="publish-artifact-info" data-no-translate>
      <Info size={16} aria-hidden="true" />
      <span>
        {url && (
          <>
            {before}
            <a
              href={url}
              onClick={(event) => {
                event.preventDefault();
                onOpen(url);
              }}
            >
              {t("Usage Policy")}
            </a>
            {after}{" "}
          </>
        )}
        {t(
          "Don’t share personal information or third-party content without permission.",
        )}
      </span>
    </div>
  );
}

/**
 * What Allowed domains shows and does for the text typed: while the field is
 * being edited nothing is checked; once it is left, the domains the check
 * refuses are named, and a list that differs from the saved one (as a set) and
 * has none of them is saved.
 */
export function embedCodeState(
  text: string,
  saved: readonly string[],
  editing: boolean,
): { error: string; save: boolean } {
  const domains = embedDomainsOf(text);
  const invalid = invalidEmbedDomains(domains);
  const changed =
    [...domains].sort().join("\n") !== [...saved].sort().join("\n");
  if (editing) return { error: "", save: false };
  if (!invalid.length) return { error: "", save: changed };
  return {
    error:
      invalid.length === 1
        ? formatText("{invalidDomain} is not a valid domain", {
            invalidDomain: invalid[0],
          })
        : formatText("{invalidDomains} are not valid domains", {
            invalidDomains: `${invalid.slice(0, -1).join(", ")} and ${invalid.at(-1)}`,
          }),
    save: false,
  };
}

const noticeMs = 5000;
export const copiedMs = 2000;

export function PublishArtifactModal({
  input,
  publication,
  surface,
  usagePolicyUrl,
  embeds = false,
  onChanged,
  onClose,
  onError,
}: {
  /** The version to publish: the content shown. */
  input: ArtifactShareInput;
  publication: ArtifactPublication | null;
  surface: PublishSurface;
  usagePolicyUrl?: string;
  /** The service serves embeds: a published version offers Get embed code. */
  embeds?: boolean;
  /** The version's publication changed: read it again. */
  onChanged: () => void;
  onClose: () => void;
  onError: (error: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [embedOpen, setEmbedOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [inviting, setInviting] = useState(false);
  const [address, setAddress] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [screenshot, setScreenshot] = useState<string>();
  // The link just made shows at once, before the publication is read again.
  const [made, setMade] = useState<HostedShare>();
  useEffect(() => setMade(undefined), [publication]);
  const share = made ?? publication?.share ?? null;
  const published = share?.status === "active";
  // The link stopped elsewhere while the dialog was open (another window,
  // Privacy): it says so for five seconds, as the reference does.
  const wasPublished = useRef(published);
  const unpublishing = useRef(false);
  useEffect(() => {
    if (wasPublished.current && !published && !unpublishing.current)
      setNotice(t("Artifact no longer published"));
    wasPublished.current = published;
    if (!published) setEmbedOpen(false);
  }, [published]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), noticeMs);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), copiedMs);
    return () => clearTimeout(timer);
  }, [copied]);
  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await task();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }
  const publish = () =>
    run(async () => {
      const next = await window.desktop.publishArtifact({
        ...input,
        screenshot,
      });
      setMade(next);
      onChanged();
      // Publish & copy link: the address goes to the clipboard.
      if (next.status === "active") await window.desktop.copyText(next.url);
    });
  const capture = () =>
    run(async () => {
      setCapturing(true);
      try {
        const { buildPreviewDocument } = await import("./preview-runtimes");
        const content = await buildPreviewDocument(
          {
            id: input.identity,
            name: input.title,
            language: input.language,
            content: input.content,
          },
          { dark: false, bytes: async () => "", claude: false },
        );
        setScreenshot(await window.desktop.captureArtifactScreenshot(content));
      } finally {
        setCapturing(false);
      }
    });
  const copy = () => {
    if (!share) return;
    void window.desktop
      .copyText(share.url)
      .then(() => setCopied(true))
      .catch(onError);
  };
  const unpublish = () =>
    run(async () => {
      unpublishing.current = true;
      try {
        await window.desktop.unpublishArtifact(input.identity);
      } catch (error) {
        unpublishing.current = false;
        throw error;
      }
      setMade(undefined);
      onChanged();
      onClose();
    });
  const embedding = embedOpen && published && share;
  const content = (
    <Modal
      title={t(
        inviting
          ? "Invite people"
          : embedding
            ? "Get embed code"
            : publishTitle(published, surface),
      )}
      back={
        inviting
          ? {
              label: t("Back to publish settings"),
              onClick: () => setInviting(false),
            }
          : embedding
            ? {
                label: t("Back to publish settings"),
                onClick: () => setEmbedOpen(false),
              }
            : undefined
      }
      onClose={onClose}
    >
      {inviting && share ? (
        <div className="publish-artifact">
          <form
            className="publish-artifact-link"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const result = await window.desktop.inviteToArtifact(
                  share.id,
                  address.trim(),
                );
                setMade(result.share);
                setNotice(
                  formatText("{address} is invited.", {
                    address: address.trim(),
                  }),
                );
                setAddress("");
                onChanged();
              });
            }}
          >
            <input
              type="email"
              required
              value={address}
              aria-label={t("Invite people by email")}
              placeholder={t("Invite people by email")}
              onChange={(event) => setAddress(event.target.value)}
            />
            <button className="primary" disabled={busy || !address.trim()}>
              {t(busy ? "Sending…" : "Send invite")}
            </button>
          </form>
          {share.invites?.map((email) => (
            <div className="publish-artifact-link" key={email}>
              <span>{email}</span>
              <button
                className="secondary"
                disabled={busy}
                aria-label={formatText("Remove {address}", { address: email })}
                onClick={() =>
                  void run(async () => {
                    setMade(
                      await window.desktop.removeArtifactInvite(
                        share.id,
                        email,
                      ),
                    );
                    setNotice(t("Invite removed."));
                    onChanged();
                  })
                }
              >
                {t("Remove")}
              </button>
            </div>
          ))}
          {notice && <div role="status">{notice}</div>}
        </div>
      ) : embedding ? (
        <>
          {notice && (
            <div className="publish-artifact-notice" role="status">
              {notice}
            </div>
          )}
          <EmbedSettings
            shareId={share.id}
            title={input.title}
            onBack={() => setEmbedOpen(false)}
            onError={onError}
          />
        </>
      ) : (
        <>
          <PublishArtifactContent
            share={share}
            liveLinks={publication?.liveLinks ?? (share ? 1 : 0)}
            busy={busy}
            copied={copied}
            notice={notice}
            title={input.title}
            usagePolicyUrl={usagePolicyUrl}
            onPublish={() => void publish()}
            onCopy={copy}
            onOpenLink={() => {
              if (share) void window.desktop.openShare(share.id).catch(onError);
            }}
            onUnpublish={() => void unpublish()}
            onUsagePolicy={(url) =>
              void window.desktop.openExternal(url).catch(onError)
            }
            onEmbed={embeds ? () => setEmbedOpen(true) : undefined}
            screenshotControl={
              /^(html|svg|react|jsx|tsx|mermaid)$/.test(input.language) ? (
                <div className="publish-artifact-screenshot">
                  <div className="publish-artifact-screenshot-image">
                    {screenshot && <img src={screenshot} alt={input.title} />}
                    {!screenshot && (
                      <button
                        type="button"
                        disabled={busy || capturing}
                        aria-label={t(
                          capturing
                            ? "Capturing screenshot"
                            : "Capture screenshot",
                        )}
                        onClick={() => void capture()}
                      >
                        <Camera size={16} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  {screenshot && (
                    <button
                      className="publish-artifact-screenshot-remove"
                      type="button"
                      aria-label={t("Remove")}
                      disabled={busy}
                      onClick={() => setScreenshot(undefined)}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              ) : undefined
            }
          />
          {published && (
            <div className="publish-artifact">
              <button
                type="button"
                className="secondary"
                onClick={() => setInviting(true)}
              >
                {t("Invite people")}
              </button>
              <p className="publish-artifact-lead">
                {t(
                  "A public link is view only. Invite people to let them comment and edit.",
                )}
              </p>
            </div>
          )}
          {published && share && (
            <Suspense fallback={null}>
              <ArtifactEditRequests
                key={share.id}
                url={share.url}
                onError={onError}
              />
            </Suspense>
          )}
        </>
      )}
    </Modal>
  );
  // Over the whole window, outside the panel header's drag region.
  return typeof document === "undefined"
    ? content
    : createPortal(content, document.body);
}
