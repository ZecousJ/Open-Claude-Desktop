import { Suspense } from "react";
import type { Item } from "../../../shared/types";
import { resourceLinks } from "../../../shared/message-resources";
import { t, tf } from "../../i18n";
import { lazyPiece, preloadPiece } from "../../ui/lazy-piece";

const ResourceLinkCards = lazyPiece(
  () => import("./ResourceLinkCards"),
  "ResourceLinkCards",
);
export const preloadResourceLinkCards = () => preloadPiece(ResourceLinkCards);

export function McpResourceLinks({
  item,
  placeholder = false,
}: {
  item: Item;
  placeholder?: boolean;
}) {
  const links = resourceLinks(item);
  if (!links.length) return null;
  if (placeholder)
    return (
      <div
        className="mcp-resource-links-placeholder"
        data-testid="mcp-resource-links-placeholder"
      >
        {links.length === 1
          ? t("1 file link. View in transcript.")
          : tf("{count} file links. View in transcript.", {
              count: links.length,
            })}
      </div>
    );
  return (
    <Suspense fallback={null}>
      <ResourceLinkCards item={item} links={links} />
    </Suspense>
  );
}
