import { app, shell, type BrowserWindow } from "electron";
import { z } from "zod";
import { preference } from "../../../shared/settings-extras";
import {
  buildSupportArchive,
  saveSupportArchive,
} from "../../support/support-bundle";
import type { NativeHost } from "./host";

type Archive = Awaited<ReturnType<typeof buildSupportArchive>>;
type Report =
  | { stage: "packaging" }
  | { stage: "ready"; archive: Archive; error?: string }
  | { stage: "ready"; error: string }
  | { stage: "exporting"; archive: Archive }
  | { stage: "saved"; referenceId: string; savedPath: string };

const actionSchema = z.enum(["cancel", "export", "reveal", "send"]);
const store = "supportBundleState_$store";
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function reportView(report?: Report) {
  const availability = { canSend: false, showSendUi: false };
  if (!report) return { ...availability, stage: "closed" } as const;
  if ("archive" in report) {
    const { archive, ...view } = report;
    return { ...availability, ...view, ...archive.preview };
  }
  return { ...availability, ...report };
}

export function registerSupportBundle(host: NativeHost) {
  let reports = new WeakMap<BrowserWindow, Report>();
  const isCurrent = (window: BrowserWindow) =>
    !window.isDestroyed() && host.windowForId(window.id) === window;
  const setReport = (window: BrowserWindow, report?: Report) => {
    if (report) reports.set(window, report);
    else reports.delete(window);
    host.emitTo(
      window,
      "SupportBundle",
      `${store}$_update`,
      reportView(report),
    );
  };
  const read = () => reportView(host.caller && reports.get(host.caller));
  host.on(`SupportBundle.${store}$_getState`, read);
  host.on(`SupportBundle.${store}$_getStateSync`, read);
  host.on("SupportBundle.submitAction", async (raw: unknown) => {
    const action = actionSchema.safeParse(raw);
    const window = host.caller;
    if (!action.success || !window) return false;
    const report = reports.get(window);
    switch (action.data) {
      case "cancel":
        setReport(window);
        return true;
      case "reveal":
        if (report?.stage === "saved") shell.showItemInFolder(report.savedPath);
        return true;
      case "send":
        return false;
      case "export": {
        if (report?.stage !== "ready" || !("archive" in report)) return false;
        const { archive } = report;
        const exporting = { stage: "exporting", archive } satisfies Report;
        const current = () =>
          isCurrent(window) && reports.get(window) === exporting;
        setReport(window, exporting);
        try {
          const savedPath = await saveSupportArchive({
            window,
            archive,
            locale: preference(host.ctx.settings(), "locale"),
            current,
          });
          if (!current()) return false;
          if (!savedPath) {
            setReport(window, { stage: "ready", archive });
            return false;
          }
          setReport(window, {
            stage: "saved",
            referenceId: archive.preview.referenceId,
            savedPath,
          });
          return true;
        } catch (error) {
          if (current())
            setReport(window, {
              stage: "ready",
              archive,
              error: errorMessage(error),
            });
          return false;
        }
      }
    }
  });

  const reset = () => {
    reports = new WeakMap();
  };
  const unsubscribe = host.ctx.onAccountDeactivating?.(reset);
  return {
    async open(window: BrowserWindow) {
      if (!isCurrent(window) || reports.get(window)?.stage === "exporting")
        return;
      const packaging = { stage: "packaging" } satisfies Report;
      const current = () =>
        isCurrent(window) && reports.get(window) === packaging;
      setReport(window, packaging);
      try {
        const archive = await buildSupportArchive({
          appVersion: host.ctx.appVersion,
          logDirectory: app.getPath("logs"),
        });
        if (current()) setReport(window, { stage: "ready", archive });
      } catch (error) {
        if (current())
          setReport(window, { stage: "ready", error: errorMessage(error) });
      }
    },
    dispose() {
      unsubscribe?.();
      reset();
    },
  };
}
