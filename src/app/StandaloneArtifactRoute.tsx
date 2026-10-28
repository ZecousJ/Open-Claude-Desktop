import { Suspense, useEffect, useMemo } from "react";
import { useApp } from "./AppContext";
import { collectArtifacts } from "../artifacts/artifact-collection";
import {
  artifactRouteId,
  findRoutedArtifact,
} from "../artifacts/artifact-route-model";
import { viewerProps } from "./ArtifactHost";
import { lazyPiece } from "../ui/lazy-piece";
import { t } from "../i18n";
import { api } from "../desktop-api";
import { mergeRoutedCopy } from "../artifacts/refresh-routed-copy";
import {
  artifactChatAction,
  relatedArtifactSessions,
} from "../artifacts/related-sessions";
import "./standalone-artifact.css";

const ArtifactPanel = lazyPiece(
  () => import("../artifacts/FileViewer"),
  "ArtifactPanel",
);

/** Resolve only the signed-in account's visible library; an ID grants no access. */
export default function StandaloneArtifactRoute() {
  const app = useApp();
  const artifacts = useMemo(
    () =>
      collectArtifacts(
        app.listed,
        app.snapshot.artifactShares ?? [],
        app.snapshot.artifactLibrary,
      ),
    [app.listed, app.snapshot.artifactShares, app.snapshot.artifactLibrary],
  );
  const found = findRoutedArtifact(artifacts, app.artifactRouteId ?? "");
  const imported =
    found?.libraryId &&
    app.snapshot.artifactLibrary.copies.find(
      (copy) => copy.libraryId === found.libraryId,
    );
  const libraryId = imported ? imported.libraryId : undefined;
  const token = imported ? imported.sharedArtifactToken : undefined;
  useEffect(() => {
    if (!libraryId || !token) return;
    let live = true;
    void api
      .refreshImportedArtifact(libraryId)
      .then((result) => {
        if (!live) return;
        app.setSnapshot((current) => {
          if (!current) return current;
          const library = mergeRoutedCopy(
            current.artifactLibrary,
            libraryId,
            token,
            result.artifact,
          );
          return library === current.artifactLibrary
            ? current
            : { ...current, artifactLibrary: library };
        });
      })
      .catch((error) => {
        if (live) app.report(error);
      });
    return () => {
      live = false;
    };
  }, [app.accountId, libraryId, token]);
  const home = () => {
    app.setArtifact(undefined);
    app.setPage("artifacts");
  };
  if (!found)
    return (
      <div className="standalone-artifact-empty" role="status">
        <h1>{t("Artifact unavailable")}</h1>
        <p>{t("This artifact is not available in this account.")}</p>
        <a
          href="/artifacts"
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            home();
          }}
        >
          {t("Artifacts")}
        </a>
      </div>
    );
  const artifact = { ...found, surface: "artifact" as const };
  const chat = relatedArtifactSessions(app.snapshot, artifact)[0];
  return (
    <Suspense
      fallback={<div className="standalone-artifact-empty" aria-busy="true" />}
    >
      <ArtifactPanel
        key={app.artifactRouteId}
        artifact={artifact}
        {...viewerProps({ ...app, artifact, active: chat, activeId: chat?.id })}
        fullPage
        onHome={() => app.newChat("chat")}
        onClose={home}
        onChat={artifactChatAction(app, artifact)}
        onSwitch={(next) => app.setArtifactRouteId?.(artifactRouteId(next))}
      />
    </Suspense>
  );
}
