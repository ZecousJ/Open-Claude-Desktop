import type { Approval, Conversation } from "./types";

// Folder-only requests use the add-folder card.
export function coworkFolderRequest(
  approval: Approval,
  conversation?: Pick<Conversation, "mode">,
) {
  if (
    conversation?.mode !== "cowork" ||
    approval.method !== "item/permissions/requestApproval"
  )
    return;
  const permissions = approval.params?.permissions;
  const files = permissions?.fileSystem;
  if (!files || permissions.network?.enabled || files.entries?.length) return;
  if (
    (files.read != null && !Array.isArray(files.read)) ||
    (files.write != null && !Array.isArray(files.write))
  )
    return;
  const paths: unknown[] = [...(files.read ?? []), ...(files.write ?? [])];
  if (
    !paths.length ||
    paths.some(
      (path) =>
        typeof path !== "string" || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path),
    )
  )
    return;
  return {
    paths: [...new Set(paths as string[])],
    reason:
      typeof approval.params?.reason === "string"
        ? approval.params.reason
        : undefined,
  };
}
