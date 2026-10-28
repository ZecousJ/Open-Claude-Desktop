import type { Artifact } from "../ui/ArtifactTypes";
import { artifactKind } from "./artifact-kind";
import { currentLocale, formatText, t } from "../i18n";

/** The Artifacts list's type filter. */
export type GalleryType = "web" | "document" | "diagram" | "data" | "code";

export type ArtifactOwner = "all" | "pinned" | "yours" | "shared" | "projects";
/** Group by: None (Last edited), Date edited, Owner or Type. */
export type ArtifactGroup = "none" | "date" | "owner" | "type";

/** Library tabs. */
export function matchesOwner(artifact: Artifact, owner: ArtifactOwner) {
  switch (owner) {
    case "pinned":
      return Boolean(artifact.pinned);
    case "yours":
      return !artifact.sharedWithYou;
    case "shared":
      return Boolean(artifact.sharedWithYou);
    case "projects":
      return Boolean(artifact.projectId);
    default:
      return true;
  }
}

export const galleryTypes: { type: GalleryType; label: string }[] = [
  { type: "web", label: "Web pages" },
  { type: "document", label: "Documents" },
  { type: "diagram", label: "Diagrams" },
  { type: "data", label: "Data" },
  { type: "code", label: "Code" },
];

export function galleryType(a: Artifact): GalleryType {
  if (a.blankArtifact)
    return a.blankArtifact.kind === "docs" || a.blankArtifact.kind === "slides"
      ? "document"
      : a.blankArtifact.kind === "dashboard"
        ? "data"
        : "web";
  switch (artifactKind(a)) {
    case "html":
    case "svg":
    case "react":
      return "web";
    case "markdown":
    case "pdf":
    case "docx":
    case "pptx":
      return "document";
    case "mermaid":
      return "diagram";
    case "csv":
    case "xlsx":
      return "data";
    default:
      return "code";
  }
}

const day = 24 * 60 * 60 * 1000;
const startOfDay = (time: number) => {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};
const monthDay = (time: number, now: number) =>
  new Date(time).toLocaleDateString(currentLocale(), {
    month: "short",
    day: "numeric",
    ...(new Date(time).getFullYear() !== new Date(now).getFullYear()
      ? { year: "numeric" }
      : {}),
  });

/**
 * The list's date sections: Today, Yesterday, the day for the rest of the
 * past week ("Sep 22"), then the month ("September", with the year when it
 * is not this year).
 */
export function gallerySection(time: number, now: number) {
  const days = Math.round((startOfDay(now) - startOfDay(time)) / day);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return monthDay(time, now);
  const date = new Date(time);
  return date.toLocaleDateString(currentLocale(), {
    month: "long",
    ...(date.getFullYear() !== new Date(now).getFullYear()
      ? { year: "numeric" }
      : {}),
  });
}

/** "4h ago", "yesterday", "Sep 22" — after "Viewed" or "Updated". */
export function galleryTime(time: number, now: number) {
  // The time that has passed decides first: a change at 23:50 read at 00:10 is
  // 20 minutes ago, not yesterday. Only a day or more is told by the calendar.
  if (now - time < day) {
    const minutes = Math.floor((now - time) / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    return `${Math.floor(minutes / 60)}h ago`;
  }
  const days = Math.round((startOfDay(now) - startOfDay(time)) / day);
  if (days <= 1) return "yesterday";
  return monthDay(time, now);
}

/**
 * galleryTime in the window's language: English keeps the compact "4h ago";
 * other languages say "4 小时前", never a half-English "已编辑 4h ago".
 */
export function galleryTimeText(time: number, now: number) {
  const text = galleryTime(time, now);
  if (currentLocale().startsWith("en")) return text;
  const ago = /^(\d+)([mh]) ago$/.exec(text);
  if (ago) {
    const n = Number(ago[1]);
    const unit = ago[2] === "m" ? "minute" : "hour";
    return formatText(n === 1 ? `{n} ${unit} ago` : `{n} ${unit}s ago`, { n });
  }
  if (text === "just now") return t("just now");
  if (text === "yesterday") return t("Yesterday");
  return text;
}

/** Case-insensitive match on the shown name or the type. */
export function matchesQuery(name: string, a: Artifact, query: string) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${name} ${a.language} ${a.filename ?? ""}`.toLowerCase();
  return words.every((word) => text.includes(word));
}
