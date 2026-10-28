import { app, dialog } from "electron";
import { nativeTranslator } from "../app/native-i18n";
import { nearestLocale } from "../../shared/locales";
import { ownershipCheck, ownershipCopy, ownershipState } from "./ownership";

let check: (() => Promise<boolean>) | undefined;

export async function ensureAppOwnership(locale = app.getLocale()) {
  if (process.platform !== "darwin" || !app.isPackaged) return true;
  check ??= ownershipCheck({
    ...ownershipState(app.getPath("userData"), process.execPath),
    confirm: async () => {
      const translate = await nativeTranslator(nearestLocale(locale));
      const result = await dialog.showMessageBox({
        type: "warning",
        message: translate(ownershipCopy.title),
        detail: translate(ownershipCopy.detail),
        buttons: [translate(ownershipCopy.fix), translate(ownershipCopy.later)],
        defaultId: 0,
        cancelId: 1,
      });
      return result.response === 0;
    },
    failed: async () => {
      const translate = await nativeTranslator(nearestLocale(locale));
      await dialog.showMessageBox({
        type: "error",
        message: translate(ownershipCopy.failed),
        detail: translate(ownershipCopy.failureDetail),
        buttons: [translate(ownershipCopy.ok)],
      });
    },
  });
  return check();
}
