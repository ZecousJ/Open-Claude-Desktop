import { useSyncExternalStore } from "react";
import type { Conversation } from "../../shared/types";
import { knownLocalFolder } from "./native-place-model";
import {
  readProjectPickerPreference,
  writeProjectPickerPreference,
  setDefaultProjectId,
  subscribeProjectPickerPreferences,
} from "./project-picker-preferences";

export const nativeDefaultFolder = (accountId: string) =>
  readProjectPickerPreference(accountId, "folder");
export function setNativeDefaultFolder(
  accountId: string,
  folder: string | undefined,
  history: readonly Conversation[],
) {
  if (folder && !knownLocalFolder(folder, history)) return false;
  if (folder) setDefaultProjectId(accountId, undefined);
  writeProjectPickerPreference(accountId, "folder", folder);
  return true;
}
export const setNativeShowFolders = (accountId: string, value: boolean) =>
  writeProjectPickerPreference(accountId, "showFolders", String(value));
export function useNativePlacePreferences(accountId: string) {
  const folder = useSyncExternalStore(
    subscribeProjectPickerPreferences,
    () => nativeDefaultFolder(accountId),
    () => undefined,
  );
  const showFolders = useSyncExternalStore(
    subscribeProjectPickerPreferences,
    () => readProjectPickerPreference(accountId, "showFolders") !== "false",
    () => true,
  );
  return { folder, showFolders };
}
