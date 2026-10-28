import { sameArtifactWrite } from "./artifact-versions";
import { useConversationServices } from "../conversation/ConversationServices";
import { Fragment, useContext, useRef, useState } from "react";
import { Download, ChevronDown } from "../ui/glyphs";
import { onThisMachine, type GeneratedFile } from "../../shared/types";
import { AppContext } from "../app/AppContext";
import { ArtifactConversation } from "./artifact-metadata";
import { t } from "../i18n";
import type { Artifact } from "../ui/components";
import { generatedArtifact } from "./generatedArtifact";
import { fileCardName } from "./file-card-name";
import { SheetTile, sheetLookOf } from "./SheetTile";
import { ArtifactSelection, sameArtifact } from "./artifact-context";

export { fileCardName };
import { Menu, type MenuPosition } from "../ui/Menu";
import { AppIcon } from "../ui/app-icon";
import { downloadArtifact, savedMessage } from "./artifact-actions";

export interface FileCardKind {
  /** "Document · PDF"; the capture names Python and TypeScript by extension only. */
  label: string;
}

const extension = (name: string) =>
  /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";

/**
 * What a generated file's card says under its name. Its tile is the original's
 * sheet for the file (sheetLookOf).
 */
export function fileCardKind(name: string): FileCardKind {
  const ext = extension(name);
  const upper = ext.toUpperCase();
  const tagged = (kind: string) => (upper ? `${kind} · ${upper}` : kind);
  if (ext === "pdf") return { label: tagged("Document") };
  // A picture reads "Image · PNG" on a violet tile.
  if (
    ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "heic"].includes(ext)
  )
    return { label: tagged("Image") };
  if (["doc", "docx", "rtf", "odt"].includes(ext))
    return { label: tagged("Document") };
  // A CSV card reads "Table · CSV".
  if (["csv", "tsv"].includes(ext)) return { label: tagged("Table") };
  if (["xls", "xlsx", "ods"].includes(ext))
    return { label: tagged("Spreadsheet") };
  if (["ppt", "pptx", "key", "odp"].includes(ext))
    return { label: tagged("Presentation") };
  if (["html", "htm", "svg"].includes(ext)) return { label: tagged("Code") };
  if (["md", "markdown", "txt"].includes(ext))
    return { label: tagged("Document") };
  if (["json", "yaml", "yml", "toml", "xml"].includes(ext))
    return { label: tagged("Code") };
  if (
    [
      "py",
      "ts",
      "tsx",
      "js",
      "jsx",
      "mjs",
      "cjs",
      "rs",
      "go",
      "java",
      "c",
      "cc",
      "cpp",
      "h",
      "hpp",
      "cs",
      "rb",
      "php",
      "swift",
      "kt",
      "sh",
      "sql",
      "css",
      "scss",
      "lua",
      "r",
    ].includes(ext)
  )
    return { label: upper };
  return { label: upper ? tagged("File") : "File" };
}

/** Why the Download menu's row is greyed. */
export const showFileReason =
  "Claudex keeps its own copy of this file: download it to use it elsewhere";

/**
 * A file the reply wrote, other than an HTML or SVG artifact: the file's sheet,
 * the name, the kind and a Download split button. The card opens the file
 * viewer. The ⌄ menu is the original's "Show in Finder" row, greyed: the file
 * lives in Claudex's own store.
 */
export function GeneratedFileCard({
  file,
  platform,
  onArtifact,
  onError,
  onNotify,
}: {
  file: GeneratedFile;
  platform?: string;
  onArtifact: (artifact: Artifact) => void;
  onError?: (error: unknown) => void;
  onNotify?: (message: string) => void;
}) {
  const services = useConversationServices();
  const artifact = generatedArtifact(file);
  const kind = fileCardKind(file.name);
  const look = sheetLookOf(file.name);
  // Open in the side panel: the card takes the original's open tint.
  const selected = useContext(ArtifactSelection);
  const open =
    !!selected &&
    !!artifact &&
    sameArtifact(selected, artifact) &&
    sameArtifactWrite(selected, artifact);
  const [menu, setMenu] = useState<MenuPosition>();
  const more = useRef<HTMLButtonElement>(null);
  // A local Code session's file is on disk in its folder: Show in Finder and
  // Copy path work there.
  const app = useContext(AppContext);
  const conversationId = useContext(ArtifactConversation);
  const conversation = app?.snapshot.conversations.find(
    (c) => c.id === conversationId,
  );
  const onDisk =
    !!conversation &&
    conversation.mode === "code" &&
    onThisMachine(conversation.environment) &&
    !!conversation.cwd &&
    file.state !== "deleted" &&
    typeof window !== "undefined" &&
    !!window.desktop?.revealConversationFile;
  const showLabel =
    platform === "win32"
      ? "Show in Explorer"
      : platform === "darwin" || !platform
        ? "Show in Finder"
        : "Show in file manager";
  if (!artifact) return null;
  const save = () =>
    void (services.downloadArtifact ?? downloadArtifact)(artifact, file.name)
      .then((saved) => saved && onNotify?.(savedMessage(saved)))
      .catch((error: unknown) => onError?.(error));
  return (
    <div
      className={`file-document-card artifact-document-card generated-file-card sheet-card${open ? " is-open" : ""}`}
      data-tint={look.tint}
      data-sheet-kind={look.kind}
    >
      <button
        className="artifact-card-main"
        aria-label={`View ${file.name}`}
        onClick={() =>
          onArtifact({
            ...artifact,
            versionPinned: Boolean(artifact.sourceDigest),
          })
        }
      >
        <SheetTile look={look} openable />
        <span className="artifact-card-description">
          <strong>{fileCardName(file.name)}</strong>
          {/* Kind and format are separate text, so the kind is translated. */}
          <small>
            {kind.label.split(" · ").map((part, index) => (
              <Fragment key={index}>
                {index > 0 && " · "}
                {part}
              </Fragment>
            ))}
          </small>
        </span>
      </button>
      <div className="generated-file-download">
        {!file.tooLarge && (
          <button onClick={save}>
            <AppIcon name="Download" />
            <span className="generated-file-download-label">Download</span>
          </button>
        )}
        <button
          ref={more}
          aria-label={`More options for ${file.name}`}
          aria-haspopup="menu"
          aria-expanded={Boolean(menu)}
          onClick={() => {
            const box = more.current?.getBoundingClientRect();
            setMenu(
              menu || !box
                ? undefined
                : { right: innerWidth - box.right, top: box.bottom + 4 },
            );
          }}
        >
          <ChevronDown size={16} strokeWidth={1.5} />
        </button>
      </div>
      {menu && (
        <Menu
          label={`Options for ${file.name}`}
          size="regular"
          width={180}
          position={menu}
          anchors={[more]}
          entries={
            onDisk
              ? [
                  {
                    label: showLabel,
                    onSelect: () =>
                      void window.desktop
                        .revealConversationFile(conversation!.id, file.path)
                        .then(
                          (shown) =>
                            shown ||
                            onNotify?.(
                              t(
                                platform === "win32"
                                  ? "Couldn’t show this in Explorer. It may have been deleted or moved."
                                  : platform === "darwin" || !platform
                                    ? "Couldn’t show this in Finder. It may have been deleted or moved."
                                    : "Couldn’t show this in the file manager. It may have been deleted or moved.",
                              ),
                            ),
                          (error: unknown) => onError?.(error),
                        ),
                  },
                  {
                    label: "Copy path",
                    onSelect: () =>
                      void services
                        .copyText(file.path)
                        .then(() => onNotify?.(t("Copied")))
                        .catch((error: unknown) => onError?.(error)),
                  },
                ]
              : [
                  {
                    label: showLabel,
                    title: showFileReason,
                    disabled: true,
                  },
                ]
          }
          onClose={() => setMenu(undefined)}
        />
      )}
    </div>
  );
}

/**
 * Download all under two or more file cards: saves each file in turn, one save
 * dialog after another; cancelling one skips it.
 */
export function DownloadAllButton({
  files,
  onError,
  onNotify,
}: {
  files: GeneratedFile[];
  onError?: (error: unknown) => void;
  onNotify?: (message: string) => void;
}) {
  const services = useConversationServices();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="generated-file-download-all"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        let saved = 0;
        try {
          if (services.downloadArtifacts) {
            // Capture the full scope during the original click. Do not ask the
            // web bridge to automate later clicks after a native chooser closes.
            const artifacts = files.flatMap((file) => {
              const artifact = !file.tooLarge && generatedArtifact(file);
              return artifact ? [artifact] : [];
            });
            saved = await services.downloadArtifacts(artifacts);
          } else {
            for (const file of files) {
              const artifact = !file.tooLarge && generatedArtifact(file);
              if (
                artifact &&
                (await (services.downloadArtifact ?? downloadArtifact)(
                  artifact,
                  file.name,
                ))
              )
                saved++;
            }
          }
          if (saved)
            onNotify?.(saved === 1 ? "Saved 1 file" : `Saved ${saved} files`);
        } catch (error) {
          onError?.(error);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Download size={17} strokeWidth={1.5} />
      Download all
    </button>
  );
}
