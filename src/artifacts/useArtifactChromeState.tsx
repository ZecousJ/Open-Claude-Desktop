import { useContext, useState, useRef, useEffect } from "react";
import { ArtifactLibraryContext } from "./artifact-context";
import {
  artifactIdentity,
  ArtifactAccountScope,
  useArtifactComments,
} from "./artifact-metadata";
import type { ArtifactShareInfo } from "../../shared/types";
import {
  useSharingStatus,
  useArtifactPublication,
  previouslyUnpublishedReason,
  publishCheckFailedReason,
} from "./artifact-publication";
import { canExportDocument } from "./artifact-kind";
import { savedMessage } from "./artifact-actions";
import type { DocumentConnector } from "../../shared/artifact-document";
import { t, formatText, currentLocale } from "../i18n";
import { locales } from "../../shared/locales";
import { markdownFence } from "./ArtifactSource";
import { useArtifactAccess } from "./artifact-access";
import { cleanArtifactName } from "./artifact-name";
import { useInlinedHtml } from "./useInlinedHtml";
import { artifactToolIdentity } from "../../shared/artifact-tools";
import { artifactDataChanged } from "../../shared/artifact-data";
import type { Artifact } from "../ui/ArtifactTypes";
import type { ArtifactDataUsage } from "../../shared/artifact-data";

/** What useArtifactChromeState needs from ArtifactChrome.tsx. */
export interface UseArtifactChromeStateKit {
  artifact: Artifact;
  commentAccess: { read: boolean; write: boolean } | undefined;
  documentBusy: boolean;
  duplicateDisabledReason: string | undefined;
  duplicateInFlight: React.RefObject<boolean>;
  duplicatePending: boolean;
  metadata: {
    canRename: boolean;
    viewedAt: number | undefined;
    rename: (name: string) => Promise<void>;
    artifact: Artifact;
    updatedAt: number | undefined;
  };
  onComment: ((text: string) => Promise<void>) | undefined;
  onDuplicate: ((artifact: Artifact) => Promise<void>) | undefined;
  onError: (e: unknown) => void;
  onNotify: ((message: string) => void) | undefined;
  onShareRequestConsumed: (() => void) | undefined;
  onSwitch: ((artifact: Artifact) => void) | undefined;
  rename: ((name: string) => Promise<void>) | null | undefined;
  setDocumentBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setDuplicating: React.Dispatch<React.SetStateAction<boolean>>;
  setStorageUsage: React.Dispatch<
    React.SetStateAction<ArtifactDataUsage | undefined>
  >;
  shown: Artifact;
  siblings: (() => Artifact[]) | undefined;
  standalone: boolean;
}

export function useArtifactChromeState(kit: UseArtifactChromeStateKit) {
  const {
    artifact,
    commentAccess,
    documentBusy,
    duplicateDisabledReason,
    duplicateInFlight,
    duplicatePending,
    metadata,
    onComment,
    onDuplicate,
    onError,
    onNotify,
    onShareRequestConsumed,
    onSwitch,
    rename,
    setDocumentBusy,
    setDuplicating,
    setStorageUsage,
    shown,
    siblings,
    standalone,
  } = kit;
  async function duplicate() {
    if (
      !onDuplicate ||
      duplicateDisabledReason !== undefined ||
      duplicatePending ||
      duplicateInFlight.current
    )
      return;
    duplicateInFlight.current = true;
    setDuplicating(true);
    setMenu(undefined);
    try {
      await onDuplicate(artifact);
    } catch (error) {
      onError(error);
    } finally {
      duplicateInFlight.current = false;
      setDuplicating(false);
    }
  }
  const library = useContext(ArtifactLibraryContext);
  const [restoring, setRestoring] = useState(false);
  const pinned = library.pinned.includes(artifactIdentity(artifact));
  const account = useContext(ArtifactAccountScope);
  const [share, setShare] = useState<ArtifactShareInfo>();
  const [shareFailed, setShareFailed] = useState(false);
  const sharing = useSharingStatus();
  // A link made on this computer before Publish (HTML and SVG) keeps its
  // copy in step; the record also tells the cards an artifact is public.
  const localShareable =
    artifact.language === "html" || artifact.language === "svg";
  const tracked = localShareable || (sharing !== null && !artifact.blob);
  const [reporting, setReporting] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const identity = artifactIdentity(artifact);
  // Publish: offered when the Claudex service takes artifact links, for the
  // version shown. It reads "Published" while that version has a public link,
  // and stays off while the check runs, after it failed, while the artifact is
  // written, and for a version that was unpublished.
  const version = shown ?? artifact;
  const documentArtifact = canExportDocument(version);
  async function presentationAction() {
    if (documentBusy) return;
    setMenu(undefined);
    setDocumentBusy(true);
    try {
      const exporter = await import("./presentation-export");
      const saved = await exporter.exportPresentation(
        version,
        metadata.artifact.name,
      );
      if (saved) onNotify?.(savedMessage(saved));
    } catch (error) {
      onError(error);
    } finally {
      setDocumentBusy(false);
    }
  }
  async function documentAction(
    format: "docx" | "pdf" | "md" | DocumentConnector,
  ) {
    if (documentBusy) return;
    setMenu(undefined);
    setDocumentBusy(true);
    try {
      const exporter = await import("./document-export");
      if (typeof format === "string") {
        const saved = await exporter.exportDocument(
          version,
          format,
          metadata.artifact.name,
        );
        if (saved) onNotify?.(savedMessage(saved));
      } else {
        const { markdown } = await exporter.documentContent(version);
        await window.desktop.saveArtifactDocument({
          ...format,
          title: metadata.artifact.name,
          markdown,
        });
        onNotify?.(t("Saved"));
      }
    } catch (error) {
      onError(error);
    } finally {
      setDocumentBusy(false);
    }
  }
  async function translateDocument(localeId: string) {
    const locale = locales.find((value) => value.id === localeId);
    if (!locale || documentBusy) return;
    setMenu(undefined);
    setDocumentBusy(true);
    try {
      const { documentContent } = await import("./document-export");
      const { markdown } = await documentContent(version);
      const fence = markdownFence(markdown);
      if (onComment) {
        await onComment(
          `${formatText("Translate “{name}” into {language}, preserving its formatting and structure. Update the artifact rather than explaining the translation.", { name: metadata.artifact.name, language: locale.english })}\n\n${version.sourcePath ? `${version.sourcePath}\n` : ""}${fence}markdown\n${markdown}\n${fence}`,
        );
      } else {
        const content = await window.desktop.translateArtifactDocument(
          markdown,
          locale.id,
        );
        if (onDuplicate) {
          await onDuplicate({
            ...version,
            language: "markdown",
            content,
            blob: false,
          });
          return;
        }
        const result = await window.desktop.duplicateArtifact({
          name: metadata.artifact.name,
          language: "markdown",
          content,
          originConversationId: version.conversationId,
        });
        onSwitch?.({
          id: result.artifact.libraryId,
          libraryId: result.artifact.libraryId,
          name: result.artifact.name,
          language: "markdown",
          content: result.artifact.content,
          conversationId: result.artifact.originConversationId,
        });
        onNotify?.(t("Saved"));
      }
    } catch (error) {
      onError(error);
    } finally {
      setDocumentBusy(false);
    }
  }
  const canPublish =
    Boolean(sharing?.artifacts) && !artifact.blob && !version.blob;
  // A page published from index.html carries the files it loads beside it.
  const page = useInlinedHtml(version, version.language === "html");
  const publishInput = {
    identity,
    title: artifact.name,
    language: version.language,
    content: page.content,
  };
  const access = useArtifactAccess(
    publishInput,
    standalone && canPublish,
    account.id,
  );
  const accessText = access.label && t(access.label);
  const shareLabel =
    standalone && accessText
      ? formatText("Share, {access}", {
          access:
            currentLocale() === "en-US" ? accessText.toLowerCase() : accessText,
        })
      : t("Share");
  const {
    check: publishCheck,
    publication,
    refresh: refreshPublication,
  } = useArtifactPublication(publishInput, canPublish);
  const published = publication?.share?.status === "active";
  const wasUnpublished = Boolean(publication?.unpublished);
  const publishDisabled =
    wasUnpublished || Boolean(artifact.generating) || publishCheck !== "ok";
  const publishReason = wasUnpublished
    ? previouslyUnpublishedReason
    : publishCheck === "failed"
      ? publishCheckFailedReason
      : undefined;
  const [publishOpen, setPublishOpen] = useState(false);
  const [versionShareOpen, setVersionShareOpen] = useState(false);
  const publishButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setShare(undefined);
    setShareFailed(false);
    if (!tracked || !window.desktop?.syncArtifactShare) return;
    let live = true;
    void window.desktop
      .syncArtifactShare({
        identity,
        title: artifact.name,
        language: artifact.language,
        content: artifact.content,
      })
      .then((value) => {
        if (live) setShare(value);
      })
      .catch((error) => {
        if (live) {
          setShareFailed(true);
          // Only a document this computer can share says why it cannot.
          if (localShareable) onError(error);
        }
      });
    // Links made or stopped elsewhere (Publish, Privacy, another window)
    // show at once.
    const off = window.desktop.onEvent?.((event) => {
      if (event.type !== "artifact-shares" || !live) return;
      setShare(
        event.shares.find((value) => value.identity === identity) ?? {
          identity,
          visibility: "private",
          showInList: true,
        },
      );
      setShareFailed(false);
    });
    return () => {
      live = false;
      off?.();
    };
  }, [
    identity,
    artifact.name,
    artifact.language,
    artifact.content,
    tracked,
    localShareable,
    onError,
  ]);
  // Another artifact does not inherit an open Publish dialog (declared
  // before the Share request below, which may open it for the new one).
  useEffect(() => setPublishOpen(false), [identity]);
  useEffect(() => setVersionShareOpen(false), [identity]);
  useEffect(() => {
    if (artifact.shareRequest) {
      setMenu(undefined);
      setVersionShareOpen(true);
      onShareRequestConsumed?.();
    }
  }, [artifact.shareRequest, onShareRequestConsumed]);
  /** Open in web: the shown version's public page in the system browser. */
  async function openInWeb() {
    const link = publication?.share;
    if (!link || link.status !== "active")
      throw new Error("This artifact no longer has a public link.");
    await window.desktop.openShare(link.id);
  }
  function openPublish() {
    setMenu(undefined);
    setPublishOpen(true);
  }
  // Share and comments wait for the artifact's sharing record, as the reference does while it loads.
  const ready =
    Boolean(share) ||
    shareFailed ||
    !tracked ||
    typeof window === "undefined" ||
    !window.desktop?.syncArtifactShare;
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(artifact.name);
  const nameInput = useRef<HTMLInputElement>(null);
  const titleButton = useRef<HTMLButtonElement>(null);
  const cancelRename = useRef(false);
  useEffect(() => {
    if (renaming) {
      nameInput.current?.focus();
      nameInput.current?.select();
    }
  }, [renaming]);
  function finishRename(commit: boolean) {
    if (cancelRename.current) {
      cancelRename.current = false;
      return;
    }
    const clean = cleanArtifactName(name);
    if (commit && clean && clean !== artifact.name) {
      try {
        void rename?.(clean).catch(onError);
      } catch (e) {
        onError(e);
        return;
      }
    }
    setRenaming(false);
    requestAnimationFrame(() => titleButton.current?.focus());
  }
  const [menu, setMenu] = useState<"title" | "comments" | "filter">();
  useEffect(() => {
    let live = true;
    setStorageUsage(undefined);
    if (menu !== "title") return;
    const load = () =>
      void window.desktop
        .artifactDataUsage?.(artifactToolIdentity(artifact))
        .then((usage) => {
          if (live) setStorageUsage(usage);
        }, onError);
    const changed = (event: Event) => {
      if ((event as CustomEvent).detail === artifactToolIdentity(artifact))
        load();
    };
    load();
    window.addEventListener(artifactDataChanged, changed);
    return () => {
      live = false;
      window.removeEventListener(artifactDataChanged, changed);
    };
  }, [menu, identity]);
  /** Rename in the title menu, or a double click on the title. */
  function startRename() {
    if (!rename) return;
    setMenu(undefined);
    setName(artifact.name);
    setRenaming(true);
  }
  const switchList = onSwitch ? (siblings?.() ?? []) : [];
  const [commentMode, setCommentMode] = useState(false);
  const saved = useArtifactComments(artifact, commentAccess);
  return {
    account,
    commentMode,
    menu,
    publication,
    publishInput,
    published,
    ready,
    refreshPublication,
    saved,
    setCommentMode,
    setMenu,
    access,
    canPublish,
    cancelRename,
    documentAction,
    documentArtifact,
    duplicate,
    finishRename,
    identity,
    name,
    nameInput,
    openInWeb,
    openPublish,
    permissionsOpen,
    pinned,
    presentationAction,
    publishButton,
    publishCheck,
    publishDisabled,
    publishOpen,
    publishReason,
    renaming,
    reporting,
    restoring,
    setName,
    setPermissionsOpen,
    setPublishOpen,
    setRenaming,
    setReporting,
    setRestoring,
    setVersionShareOpen,
    shareLabel,
    sharing,
    startRename,
    switchList,
    titleButton,
    translateDocument,
    version,
    versionShareOpen,
    wasUnpublished,
  } as const;
}
