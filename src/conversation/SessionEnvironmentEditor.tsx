import { Suspense } from "react";
import { useCloudEnvironmentEditing } from "../composer/cloud-environments";
import { lazyPiece } from "../ui/lazy-piece";

const CloudEnvironmentDialog = lazyPiece(
  () => import("../composer/CloudEnvironmentDialog"),
  "CloudEnvironmentDialog",
);

/**
 * The cloud environment editor over an open cloud Code session, for its
 * title menu's Edit cloud environment (the home composer draws its own).
 */
export function SessionEnvironmentEditor({
  onError,
}: {
  onError: (error: unknown) => void;
}) {
  const editing = useCloudEnvironmentEditing();
  if (!editing) return null;
  return (
    <Suspense fallback={null}>
      <CloudEnvironmentDialog
        environment={editing === "new" ? undefined : editing}
        onError={onError}
      />
    </Suspense>
  );
}
