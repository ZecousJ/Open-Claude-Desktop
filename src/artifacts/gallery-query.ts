import { useCollectionQuery } from "../collections/useCollectionQuery";
import type { ArtifactGroup, ArtifactOwner } from "./gallery";

// c230724a2-1I8WxdA6:4470 and c73d5fa6d-C_YhEgJ4:527–546.
// The visible Yours tab uses source URL value mine; tab transitions replace.
export function useGalleryQuery(web: boolean) {
  const query = useCollectionQuery(web);
  const tab = query.params.get("tab");
  const owner: ArtifactOwner =
    tab === "mine"
      ? "yours"
      : tab === "shared" || tab === "projects" || tab === "pinned"
        ? tab
        : "all";
  const group = query.params.get("group");
  const groupBy: ArtifactGroup =
    group === "date" || group === "owner" || group === "type" ? group : "none";
  return {
    ...query,
    owner,
    groupBy,
    setGroupBy(value: ArtifactGroup) {
      query.update({ group: value === "none" ? undefined : value }, "replace");
    },
    setOwner(value: ArtifactOwner) {
      query.update(
        {
          tab: value === "all" ? undefined : value === "yours" ? "mine" : value,
        },
        "replace",
      );
    },
  };
}
