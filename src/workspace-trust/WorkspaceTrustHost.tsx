import { Suspense } from "react";
import { lazyPiece } from "../ui/lazy-piece";
import { useHostedTrustQuestion } from "./trust-request";

const WorkspaceTrustDialog = lazyPiece(
  () => import("./WorkspaceTrustDialog"),
  "WorkspaceTrustDialog",
);

/**
 * Where "Trust this workspace?" shows (the composer host, like Cowork's
 * folder access): the dialog and its styles load the first time it asks.
 */
export function WorkspaceTrustHost() {
  // Split panes each mount one; the oldest (the primary pane's) shows it.
  const question = useHostedTrustQuestion();
  if (!question) return null;
  return (
    <Suspense fallback={null}>
      <WorkspaceTrustDialog question={question} />
    </Suspense>
  );
}
