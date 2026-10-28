import type { Conversation } from "../../shared/types";
import { AppIcon } from "../ui/app-icon";
import { currentLocale, t } from "../i18n";
import { codePlace, type CodeListView } from "./code-list-view";
import { shownFolder } from "../../shared/session-folder";

/** O14/shared-20 L2 (26211): the second line is conditional place/blocked
 * metadata. Connection state belongs to the accessible name, not a fake subtitle. */
export function codeMetadata(
  c: Conversation,
  view: CodeListView,
  needsApproval: boolean,
  ownSection: boolean,
) {
  if (!view.metadata || c.pinned) return undefined;
  if (
    needsApproval ||
    c.sessionState === "blocked" ||
    c.turns.at(-1)?.status === "failed"
  )
    return view.groupBy === "status"
      ? undefined
      : { blocked: true, parts: [t("Blocked")] };
  const folder = shownFolder(c.cwd)?.split(/[\\/]/).filter(Boolean).at(-1);
  const showFolder = folder && (view.groupBy !== "folder" || ownSection);
  const parts = [c.branch, showFolder ? folder : undefined].filter(
    (s): s is string => Boolean(s),
  );
  return parts.length
    ? { blocked: false, parts, branch: Boolean(c.branch) }
    : undefined;
}
export function CodeRowMetadata({
  line,
}: {
  line: NonNullable<ReturnType<typeof codeMetadata>>;
}) {
  return (
    <span
      className="code-row-metadata"
      // Keep these conditional styles with the actual line. They apply on its
      // first paint without adding another stylesheet to every page's load.
      style={{
        gridColumn: "1 / -1",
        gridRow: 2,
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: 20,
        minWidth: 0,
        overflow: "clip",
        whiteSpace: "nowrap",
        color: "var(--text-muted)",
        fontSize: 13,
        lineHeight: "16px",
        paddingInlineEnd: 12,
        marginInlineEnd: -24,
        maskImage: "linear-gradient(90deg,#000 calc(100% - 12px),transparent)",
      }}
      title={new Intl.ListFormat(currentLocale(), { type: "unit" }).format(
        line.parts,
      )}
    >
      <span
        className="code-metadata-primary"
        style={{ display: "flex", alignItems: "center", gap: 4, flex: "none" }}
      >
        {"branch" in line && line.branch && (
          <AppIcon name="GitBranch" size={12} />
        )}
        <bdi style={{ flex: "none" }}>{line.parts[0]}</bdi>
      </span>
      {line.parts.slice(1).map((part, i) => (
        <bdi key={i} style={{ flex: "none" }}>
          {part}
        </bdi>
      ))}
    </span>
  );
}
/**
 * The glyph that ends a Code row: where the session runs. Cloud and self-hosted
 * runners show Cloud, SSH CommandLine, Remote Control Laptop (LaptopSlash while
 * the computer is offline); a session on this computer shows none (cL drops
 * "local"), which is why the desktop's own sessions end bare.
 */
export function codeEnvironmentGlyph(c: Conversation) {
  const place = codePlace(c);
  return place.kind === "cloud"
    ? "Cloud"
    : place.kind === "ssh"
      ? "CommandLine"
      : place.kind === "bridge"
        ? place.connected === false
          ? "LaptopSlash"
          : "Laptop"
        : undefined;
}
export function CodeEnvironmentMark({
  conversation: c,
}: {
  conversation: Conversation;
}) {
  const name = codeEnvironmentGlyph(c);
  if (!name) return null;
  return (
    <span className="row-status code-row-environment" aria-hidden="true">
      <AppIcon name={name} size={16} data-env-glyph={codePlace(c).kind} />
    </span>
  );
}
export function codePlaceDescription(c: Conversation) {
  const place = codePlace(c);
  if (place.kind === "local") return undefined;
  const label =
    place.kind === "bridge" && c.linkedComputerName
      ? place.label
      : t(place.label);
  return [
    label,
    place.connected === undefined
      ? undefined
      : t(place.connected ? "Connected" : "Offline"),
  ]
    .filter(Boolean)
    .join(" · ");
}
