import { Suspense } from "react";
import type { Item } from "../../../shared/types";
import { lazyPiece, preloadPiece } from "../../ui/lazy-piece";
export { webFetchLabel } from "./web-fetch-label";

const FetchRow = lazyPiece(() => import("./WebFetchRowContent"), "WebFetchRow");
export const preloadWebFetchRow = () => preloadPiece(FetchRow);

export function WebFetchRow({ item }: { item: Item }) {
  return (
    <Suspense fallback={null}>
      <FetchRow item={item} />
    </Suspense>
  );
}
