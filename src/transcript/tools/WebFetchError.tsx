import { Suspense } from "react";
import type { Item } from "../../../shared/types";
import { isWebFetch } from "../../../shared/web-fetch-item";
import { lazyPiece } from "../../ui/lazy-piece";

const FetchError = lazyPiece(
  () => import("./tool-message-details"),
  "WebFetchError",
);

export function WebFetchError({ item }: { item: Item }) {
  return isWebFetch(item) ? (
    <Suspense fallback={null}>
      <FetchError item={item} />
    </Suspense>
  ) : null;
}
