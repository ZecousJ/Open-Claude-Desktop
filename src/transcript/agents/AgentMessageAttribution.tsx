import { Suspense } from "react";
import type { Item } from "../../../shared/types";
import { lazyPiece } from "../../ui/lazy-piece";

const Attribution = lazyPiece(
  () => import("../tools/tool-message-details"),
  "AgentMessageAttribution",
);

export function AgentMessageAttribution({ item }: { item: Item }) {
  return item.origin?.kind === "peer" || item.notice === "agents_killed" ? (
    <Suspense fallback={null}>
      <Attribution item={item} />
    </Suspense>
  ) : null;
}
