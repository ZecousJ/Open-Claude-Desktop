import { useCollectionQuery } from "../collections/useCollectionQuery";
import type { ArtifactGroup, ArtifactOwner } from "./gallery";

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
