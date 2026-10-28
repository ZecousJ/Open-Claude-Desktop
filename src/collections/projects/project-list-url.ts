import { formatWebRoute } from "../../web/routes";
import { useCollectionQuery } from "../useCollectionQuery";
import {
  storedProjectGrouping,
  storedProjectSort,
  storeProjectGrouping,
  storeProjectSort,
  type ProjectSort,
  type ProjectView,
} from "./project-list";

/**
 * A place transition owns its pathname; list query state and Settings hash
 * survive. Changes URLSearchParams in place.
 */
export function projectPlaceURL(
  projectId: string | undefined,
  location: { search: string; hash: string },
) {
  const path = formatWebRoute(
    projectId
      ? { kind: "project", id: projectId }
      : { kind: "page", page: "projects" },
  )!;
  return `${path}${location.search}${location.hash}`;
}

const sortURL: Record<ProjectSort, string> = {
  updated: "updated_at",
  created: "created_at",
  name: "name",
};

/** Supported local project category is mine. Shared categories and Tasks require
 * backend membership/task records. Preserve those parameters until the person
 * chooses a supported mine/archive view. */
export function useProjectListQuery(web: boolean) {
  const query = useCollectionQuery(web);
  const rawSort = query.params.get("sort_by");
  const sort: ProjectSort =
    rawSort === "created_at"
      ? "created"
      : rawSort === "name"
        ? "name"
        : rawSort === "updated_at" || web
          ? "updated"
          : storedProjectSort();
  const grouped = query.params.has("group")
    ? query.params.get("group") === "type"
    : storedProjectGrouping();
  const view: ProjectView =
    query.params.get("archived") === "true" ? "archived" : "mine";
  return {
    ...query,
    sort,
    grouped,
    view,
    setSort(value: ProjectSort) {
      storeProjectSort(value);
      query.update({ sort_by: sortURL[value] });
    },
    setGrouped(value: boolean) {
      storeProjectGrouping(value);
      query.update({ group: value ? "type" : "none" });
    },
    setView(value: ProjectView) {
      query.update({
        category: "mine",
        archived: value === "archived" ? "true" : undefined,
        view: undefined,
      });
    },
  };
}
