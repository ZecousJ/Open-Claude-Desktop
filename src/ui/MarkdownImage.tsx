import { useConversationServices } from "../conversation/ConversationServices";
import { useState, type ReactNode } from "react";
import { Image as ImageIcon } from "./glyphs";
import { Spinner } from "./Spinner";
import { remoteImageRefusal } from "../../shared/external-links";
import { externalUrl } from "./ExternalLinks";
import { usePolicy } from "../policy/PolicyContext";
import { openImageGroup } from "../lightbox/open";
import { ImageActions } from "./ImageActions";
import { t } from "../i18n";

type ImageProps = { src?: string | Blob; alt?: string };

/**
 * A remote image in model output. Nothing is fetched until the person chooses
 * Load image, so a reply cannot reveal that it was read; the main process then
 * fetches it as a data: URL the page policy accepts. The administrator can turn
 * remote images off or limit them to some sites; the placeholder then says so
 * instead of offering to load.
 */
/*
 * Passed to react-markdown directly (not wrapped in a closure) so that a
 * re-render of the reply keeps the same component and its loaded state.
 */
export function MarkdownImage({ src, alt }: ImageProps) {
  const services = useConversationServices();
  const url = externalUrl(typeof src === "string" ? src : undefined);
  const refusal = usePolicyRefusal(url);
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "loaded"; data: string }
    | { kind: "failed" }
  >({ kind: "idle" });
  if (state.kind === "loaded")
    return (
      <ImageActions src={state.data} fileName={alt}>
        <img
          className="markdown-image"
          src={state.data}
          alt={alt ?? ""}
          onError={() => setState({ kind: "failed" })}
          // Full screen with the reply's other loaded pictures (lightbox),
          // unless the picture is a link.
          onClick={(event) =>
            !event.currentTarget.closest("a") &&
            openImageGroup(
              event.currentTarget.closest(".markdown"),
              event.currentTarget,
              "img.markdown-image",
            )
          }
        />
      </ImageActions>
    );
  return (
    <ImagePlaceholder url={url} alt={alt}>
      {url && refusal && (
        <span className="markdown-image-error">{refusal}</span>
      )}
      {url && !refusal && (
        <button
          type="button"
          className="small-action"
          disabled={state.kind === "loading"}
          aria-label={state.kind === "loading" ? t("Loading image") : undefined}
          onClick={() => {
            setState({ kind: "loading" });
            services
              .loadRemoteImage(url)
              .then((data) => setState({ kind: "loaded", data }))
              .catch(() => setState({ kind: "failed" }));
          }}
        >
          {state.kind === "loading" && (
            <Spinner
              inheritColor
              size={12}
              className="spin"
              aria-hidden="true"
            />
          )}
          {state.kind === "failed" ? "Try again" : "Load image"}
        </button>
      )}
      {state.kind === "failed" && (
        <span className="markdown-image-error" role="status">
          {t("This image didn’t load.")}
        </span>
      )}
    </ImagePlaceholder>
  );
}

/**
 * An image in the service's release notes: shown as its label and host
 * only; release notes never load remote images.
 */
export function MarkdownImageLabel({ src, alt }: ImageProps) {
  return (
    <ImagePlaceholder
      url={externalUrl(typeof src === "string" ? src : undefined)}
      alt={alt}
    />
  );
}

function usePolicyRefusal(url: string | undefined) {
  const policy = usePolicy();
  return url ? remoteImageRefusal(url, policy) : undefined;
}

function ImagePlaceholder({
  url,
  alt,
  children,
}: {
  url?: string;
  alt?: string;
  children?: ReactNode;
}) {
  let host = "";
  try {
    host = url ? new URL(url).host : "";
  } catch {
    /* Not a web address: shown without a load action. */
  }
  return (
    <span className="markdown-image-placeholder">
      <ImageIcon size={14} aria-hidden="true" />
      <span className="markdown-image-label">{alt?.trim() || "Image"}</span>
      {host && <span className="markdown-image-host">{host}</span>}
      {children}
    </span>
  );
}
