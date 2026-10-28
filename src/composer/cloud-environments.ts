import { useEffect, useSyncExternalStore } from "react";
import { api } from "../desktop-api";
import { t } from "../i18n";
import {
  type CloudEnvironmentConfig,
  type CloudEnvironmentInput,
} from "../../shared/cloud-environments-api";

let environments: CloudEnvironmentConfig[] = [];
let selected = "default";
/** Set only by an actual pick; the first environment is selected by default without being one. */
let picked = "";
let loaded = false;
let loadError: unknown;
let editing: CloudEnvironmentConfig | "new" | undefined;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const changed = () => listeners.forEach((listener) => listener());
export const currentCloudEnvironmentId = () => selected;
export function selectCloudEnvironment(id: string) {
  selected = id;
  picked = id;
  changed();
}
export function editCloudEnvironment(value?: CloudEnvironmentConfig) {
  editing = value ?? "new";
  changed();
}
/**
 * Edit cloud environment from a cloud session's title menu: the
 * environment the session runs in (the default one when it names none).
 */
export async function editSessionCloudEnvironment(id: string | undefined) {
  if (!loaded) await refreshCloudEnvironments();
  const environment =
    environments.find((entry) => entry.id === (id ?? "default")) ??
    (id ? undefined : environments[0]);
  if (!environment)
    throw new Error(t("This session’s cloud environment no longer exists."));
  editCloudEnvironment(environment);
}
/** The environment being edited, for a host that draws the editor. */
export function useCloudEnvironmentEditing() {
  return useSyncExternalStore(
    subscribe,
    () => editing,
    () => editing,
  );
}
export function closeCloudEnvironmentEditor() {
  editing = undefined;
  changed();
}
export async function refreshCloudEnvironments() {
  try {
    const next: unknown = await api.listCloudEnvironments();
    if (
      !Array.isArray(next) ||
      next.some(
        (entry) =>
          !entry ||
          typeof entry.id !== "string" ||
          typeof entry.name !== "string" ||
          !["none", "trusted", "custom", "full"].includes(entry.network) ||
          !Array.isArray(entry.allowedDomains) ||
          entry.allowedDomains.some(
            (domain: unknown) => typeof domain !== "string",
          ) ||
          typeof entry.includeDefaultDomains !== "boolean" ||
          typeof entry.variables !== "string" ||
          typeof entry.setupScript !== "string" ||
          typeof entry.updatedAt !== "number" ||
          !Number.isFinite(entry.updatedAt),
      )
    )
      throw new Error(t("Couldn’t load cloud environments"));
    environments = next;
    if (!environments.some((entry) => entry.id === selected))
      selected = environments[0]?.id ?? "";
    loaded = true;
    loadError = undefined;
  } catch (error) {
    loadError = error;
    throw error;
  } finally {
    // Keep the last valid profiles when a later request fails.
    changed();
  }
}
export async function saveCloudEnvironment(input: CloudEnvironmentInput) {
  const saved = await api.saveCloudEnvironment(input);
  await refreshCloudEnvironments();
  selectCloudEnvironment(saved.id);
  return saved;
}
export function useCloudEnvironments(onError: (error: unknown) => void) {
  const rows = useSyncExternalStore(
    subscribe,
    () => environments,
    () => environments,
  );
  const selectedId = useSyncExternalStore(
    subscribe,
    () => selected,
    () => selected,
  );
  const pickedId = useSyncExternalStore(
    subscribe,
    () => picked,
    () => picked,
  );
  const editor = useSyncExternalStore(
    subscribe,
    () => editing,
    () => editing,
  );
  const ready = useSyncExternalStore(
    subscribe,
    () => loaded,
    () => loaded,
  );
  const error = useSyncExternalStore(
    subscribe,
    () => loadError,
    () => loadError,
  );
  useEffect(() => {
    const refresh = () => {
      void refreshCloudEnvironments().catch(onError);
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  return {
    environments: rows,
    selectedId,
    pickedId,
    editing: editor,
    loaded: ready,
    error,
  };
}
