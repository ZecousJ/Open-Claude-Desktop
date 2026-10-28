import { Suspense, useState } from "react";
import type { ApprovedDirectoryEntry } from "../../../shared/directory-submissions";
import type { PluginEntry } from "../../../shared/collections-api";
import { lazyPiece } from "../../ui/lazy-piece";
import { usePlugins } from "../../plugins/usePlugins";

const PluginRows = lazyPiece(
  () => import("../../plugins/PluginRows"),
  "PluginRows",
);
const PluginDetailDialog = lazyPiece(
  () => import("../../plugins/PluginDetailDialog"),
  "PluginDetailDialog",
);

export function popularDirectoryPlugins(
  entries: ApprovedDirectoryEntry[],
  plugins: PluginEntry[],
) {
  const seen = new Set<string>();
  return entries
    .filter((entry) => entry.kind === "plugin" && entry.curation?.popular)
    .flatMap((entry) => {
      const plugin = plugins.find(
        (plugin) =>
          entry.name === plugin.title ||
          entry.name === plugin.name ||
          entry.id === plugin.id,
      );
      if (!plugin || seen.has(plugin.id)) return [];
      seen.add(plugin.id);
      return [plugin];
    });
}

export default function ConnectorPlugins({
  entries,
  onShowAll,
  onError,
}: {
  entries: ApprovedDirectoryEntry[];
  onShowAll: () => void;
  onError: (error: unknown) => void;
}) {
  const plugins = usePlugins();
  const [detail, setDetail] = useState<PluginEntry>();
  const popular = popularDirectoryPlugins(
    entries,
    plugins.catalog?.plugins ?? [],
  );
  if (!popular.length) return null;
  return (
    <section className="connector-directory-section">
      <div className="customize-directory-head">
        <h2>Popular plugins</h2>
        <button type="button" onClick={onShowAll}>
          Show all
        </button>
      </div>
      <Suspense fallback={null}>
        <PluginRows
          entries={popular}
          plugins={plugins}
          onOpen={setDetail}
          onError={onError}
        />
        {detail && (
          <PluginDetailDialog
            plugin={detail}
            plugins={plugins}
            onClose={() => setDetail(undefined)}
            onError={onError}
          />
        )}
      </Suspense>
    </section>
  );
}
