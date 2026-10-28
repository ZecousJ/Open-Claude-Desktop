import type { PluginCopy, PluginEntry } from "../../shared/collections-api";
import {
  angleOrHidden,
  nameUnusable,
  pluginDuplicateFailed,
  pluginGone,
  pluginNameTaken,
  pluginRenameBusy,
  pluginRenameFailed,
  pluginRenamePlan,
  pluginSlug,
  renameSameName,
} from "../../shared/duplicate-name";
import { formatText } from "../i18n";
import { showToast } from "../ui/toast-store";
import { NameCopyDialog } from "../collections/customize/NameCopyDialog";
import { nameRequired } from "../collections/customize/CreateSkillDialog";
import { pluginErrorText } from "./plugin-model";
import { isPluginOperationRetired, usePluginOwner } from "./usePlugins";

/** Refusals the dialog shows as they are. */
const shownAsIs = new Set([
  pluginNameTaken,
  renameSameName,
  nameUnusable,
  pluginRenameBusy,
  angleOrHidden,
  nameRequired,
]);

/**
 * What a failed rename shows under the field: the known refusals as they are,
 * anything else as "Plugin rename failed. You can try again.". A plugin that is
 * gone answers `"gone"`: live shows that as a notice and closes.
 */
export function renameFailureText(error: unknown): string | "gone" {
  const text = pluginErrorText(error).replace(/^Error: /, "");
  if (text === pluginGone) return "gone";
  if (shownAsIs.has(text)) return text;
  return /lowercase letters, numbers, and hyphens/.test(text)
    ? nameRequired
    : pluginRenameFailed;
}

/**
 * What a failed duplicate shows under the field: the known refusals as they
 * are, anything else as "Plugin duplicate failed. You can try again.", never
 * the runtime's own text.
 */
export function duplicateFailureText(error: unknown): string {
  const text = pluginErrorText(error).replace(/^Error: /, "");
  if (shownAsIs.has(text)) return text;
  return /lowercase letters, numbers, and hyphens/.test(text)
    ? nameRequired
    : pluginDuplicateFailed;
}

/** The display name Rename compares with: "" when it is only the name. */
function ownTitle(plugin: PluginEntry): string {
  return plugin.title !== plugin.name ? plugin.title : "";
}

/**
 * Rename plugin: "Rename plugin", a Name field ("New plugin name") holding the
 * display name (or the name), "Saved as <name>", the same-name refusal once the
 * person has typed, Cancel / Rename, then "Renamed to {pluginName}" and the
 * renamed plugin's page. Built on Claudex's name dialog (Duplicate plugin's).
 */
export function PluginRenameDialog({
  plugin,
  rename,
  onRenamed,
  onClose,
  isCurrent,
}: {
  plugin: PluginEntry;
  rename: (
    id: string,
    to: PluginCopy,
  ) => Promise<{ id: string; appsNeedingAuth: string[] }>;
  /** The renamed plugin's id. */
  onRenamed: (id: string) => void;
  onClose: () => void;
  isCurrent?: () => boolean;
}) {
  const owner = usePluginOwner();
  const ownsRename = () => owner.current() && (!isCurrent || isCurrent());
  const current = { name: plugin.name, title: ownTitle(plugin) };
  return (
    <NameCopyDialog
      title="Rename plugin"
      action="Rename"
      fieldLabel="New plugin name"
      initialName={current.title || current.name}
      slug={pluginSlug}
      plan={(typed) => pluginRenamePlan(typed, current)}
      savedAs="Saved as "
      sameMessage={renameSameName}
      checkAfterEdit
      isCurrent={ownsRename}
      onSubmit={async (typed) => {
        const plan = pluginRenamePlan(typed, current);
        let renamed: { id: string };
        try {
          renamed = await rename(plugin.id, {
            name: plan.savedAs,
            ...(plan.displayName !== undefined
              ? { displayName: plan.displayName }
              : {}),
          });
        } catch (error) {
          if (isPluginOperationRetired(error) || !ownsRename()) throw error;
          const failure = renameFailureText(error);
          if (failure !== "gone") throw new Error(failure);
          // Live: an error notice, and the dialog closes.
          showToast(pluginGone);
          return;
        }
        if (!ownsRename()) return;
        showToast(
          formatText("Renamed to {pluginName}", {
            pluginName: plan.displayName ?? plan.savedAs,
          }),
        );
        onRenamed(renamed.id);
      }}
      onClose={onClose}
    />
  );
}
