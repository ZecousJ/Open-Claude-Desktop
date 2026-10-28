import fs from "node:fs";
import path from "node:path";
import type { AppContext } from "../app/app-context";
import type { Conversation } from "../../shared/types";
import { hasLocalBrowserExecution } from "../../shared/browser-execution-eligibility";

/** Always consult the active backend store, never renderer-supplied origin data. */
export function ownsNativeBrowserExecution(
  ctx: Pick<AppContext, "store" | "remote">,
  id: string,
): boolean {
  const conversation = ctx.store.conversations.find((value) => value.id === id);
  if (!hasLocalBrowserExecution(conversation)) return false;
  if (!conversation?.deviceChatOrigin) return true;
  if (
    !ctx.remote?.ready ||
    conversation.deviceChatOrigin.accountScope !==
      String(ctx.remote.session.userId)
  )
    return false;
  return ownsReplicaWorkspace(ctx.store.root, conversation);
}

function ownsReplicaWorkspace(root: string, conversation: Conversation) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(conversation.id) || !conversation.cwd)
    return false;
  const expected = path.join(
    root,
    "workspace",
    "chat-devices",
    conversation.id,
  );
  if (path.resolve(conversation.cwd) !== path.resolve(expected)) return false;
  try {
    const canonicalRoot = fs.realpathSync(root);
    return (
      fs.statSync(expected).isDirectory() &&
      fs.realpathSync(expected) ===
        path.join(canonicalRoot, "workspace", "chat-devices", conversation.id)
    );
  } catch {
    return false;
  }
}
