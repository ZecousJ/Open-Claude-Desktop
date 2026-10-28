import {
  Globe,
  MessageCircleMore,
  Pencil,
  Settings,
  Upload,
} from "../ui/glyphs";
import type { PageMenuEntry } from "../collections/PageMenu";

/**
 * Source actions keep this order and are absent when their backend/caller does
 * not offer the corresponding capability.
 */
export function pluginAddMenu({
  connector = [],
  onUpload,
  onCreate,
  onCreateWithClaudex,
  onAddMarketplace,
  onManageMarketplaces,
}: {
  connector?: PageMenuEntry[];
  onUpload?: () => void;
  onCreate?: () => void;
  onCreateWithClaudex?: () => void;
  onAddMarketplace?: () => void;
  onManageMarketplaces?: () => void;
}): PageMenuEntry[] {
  const entries: PageMenuEntry[] = [];
  if (onAddMarketplace)
    entries.push({
      label: "Add marketplace",
      icon: Globe,
      onSelect: onAddMarketplace,
    });
  if (onManageMarketplaces)
    entries.push({
      label: "Manage marketplaces",
      icon: Settings,
      onSelect: onManageMarketplaces,
    });
  if (onUpload)
    entries.push({ label: "Upload plugin", icon: Upload, onSelect: onUpload });
  if (onCreate)
    entries.push({
      label: "Create a plugin",
      icon: Pencil,
      onSelect: onCreate,
    });
  if (onCreateWithClaudex)
    entries.push({
      label: "Create with Claudex",
      icon: MessageCircleMore,
      onSelect: onCreateWithClaudex,
    });
  if (connector.length)
    entries.push(
      ...(entries.length ? [{ separator: true } as const] : []),
      ...connector,
    );
  return entries;
}
