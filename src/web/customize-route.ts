import {
  connectorCategory,
  connectorDirectoryTypes,
  type ConnectorDirectoryType,
} from "../settings/directory/connector-categories";

/** Account-visible Customize addresses, observed in the October 16 captures. */
export interface CustomizePlace {
  section: "skills" | "connectors" | "plugins";
  view: "yours" | "discover";
  detailId?: string;
  /** Observed standalone upload page, distinct from Settings' dialog. */
  pluginPage?: "upload";
  /** A published connector taxonomy ID, e.g. topic-notes-memory. */
  category?: string;
  connectorType?: ConnectorDirectoryType;
  /** Published whole-directory scope, distinct from the discovery landing. */
  connectorScope?: "all";
  /** Installed skill files have their own observed /contents address. */
  detailView?: "overview" | "contents";
}

export const defaultCustomizePlace: CustomizePlace = {
  section: "skills",
  view: "discover",
};

/** Undefined leaves malformed or unknown paths to the normal not-found route. */
export function parseCustomizePath(path: string): CustomizePlace | undefined {
  if (path === "/customize/plugins/new/upload")
    return { section: "plugins", view: "yours", pluginPage: "upload" };
  const categoryPath =
    /^\/customize\/connectors\/([^/]+)(?:\/(trending|new|verified|community|in-chat-ui|desktop-extensions))?$/.exec(
      path,
    );
  if (categoryPath && !["yours", "discover"].includes(categoryPath[1])) {
    try {
      const slug = decodeURIComponent(categoryPath[1]);
      const category = /^[a-z][a-z0-9-]*$/.test(slug)
        ? connectorCategory(slug)
        : undefined;
      const type = connectorDirectoryTypes.find((type) => type.path === slug);
      if (category || slug === "all" || (type && !categoryPath[2]))
        return {
          section: "connectors",
          view: "discover",
          ...(category
            ? { category: category.id }
            : slug === "all"
              ? { connectorScope: "all" as const }
              : { connectorType: type!.id }),
          ...(categoryPath[2]
            ? {
                connectorType: connectorDirectoryTypes.find(
                  (type) => type.path === categoryPath[2],
                )!.id,
              }
            : {}),
        };
    } catch {
      return undefined;
    }
  }
  const match =
    /^\/customize\/(skills|connectors|plugins)(?:\/(yours|discover))?(?:\/id\/([^/]+))?(?:\/(contents))?$/.exec(
      path,
    );
  if (!match) return undefined;
  if (match[4] && (match[1] !== "skills" || match[2] !== "yours" || !match[3]))
    return undefined;
  let detailId: string | undefined;
  if (match[3]) {
    try {
      detailId = decodeURIComponent(match[3]);
      if (!detailId || /[/\\\u0000-\u001f]/.test(detailId)) return undefined;
    } catch {
      return undefined;
    }
  }
  return {
    section: match[1] as CustomizePlace["section"],
    view: match[2] === "yours" ? "yours" : "discover",
    ...(detailId === undefined ? {} : { detailId }),
    ...(match[4] ? { detailView: "contents" as const } : {}),
  };
}

export function customizePath(place: CustomizePlace): string {
  if (place.section === "plugins" && place.pluginPage === "upload")
    return "/customize/plugins/new/upload";
  const base = `/customize/${place.section}${place.view === "yours" ? "/yours" : ""}`;
  const category =
    place.section === "connectors" &&
    place.view === "discover" &&
    !place.detailId
      ? connectorCategory(place.category)
      : undefined;
  if (
    category ||
    (place.section === "connectors" &&
      place.view === "discover" &&
      !place.detailId &&
      (place.connectorScope === "all" ||
        (place.connectorType && place.connectorType !== "all")))
  ) {
    const type = connectorDirectoryTypes.find(
      (type) => type.id === place.connectorType,
    )?.path;
    const scope =
      category?.id ?? (place.connectorScope === "all" ? "all" : undefined);
    return `${base}${scope ? `/${encodeURIComponent(scope)}` : ""}${type ? `/${type}` : ""}`;
  }
  return place.detailId === undefined
    ? base
    : `${base}/id/${encodeURIComponent(place.detailId)}${
        place.section === "skills" &&
        place.view === "yours" &&
        place.detailView === "contents"
          ? "/contents"
          : ""
      }`;
}
