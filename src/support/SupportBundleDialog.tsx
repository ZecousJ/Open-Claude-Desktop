import { useEffect, useRef, useState } from "react";
import type { SupportBundlePreview } from "../../shared/support-bundle-api";
import { surface } from "../../shared/host";
import { Modal } from "../ui/Controls";
import { formatText, useT } from "../i18n";
import "./support-bundle.css";

export default function SupportBundleDialog({ onClose }: { onClose(): void }) {
  const t = useT();
  const [report, setReport] = useState<SupportBundlePreview>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(false);
  const [saved, setSaved] = useState<string>();
  const [screenshot, setScreenshot] = useState(false);
  const [platform, setPlatform] = useState("");
  const generation = useRef(0);
  const generate = async (screenshotToken?: string) => {
    const current = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const report = await window.desktop.createSupportBundle({
        screenshotToken,
      });
      if (current === generation.current) setReport(report);
    } catch (error) {
      if (current === generation.current)
        setError(t(error instanceof Error ? error.message : String(error)));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  useEffect(() => {
    void generate();
    void window.desktop
      .getSupportSystemInfo()
      .then((info) => setPlatform(info.platform))
      .catch(() => {});
    return () => {
      generation.current++;
      void window.desktop.discardSupportBundle();
    };
  }, []);
  const capture = async () => {
    setBusy(true);
    try {
      const screenshot = await window.desktop.captureFeedbackScreenshot();
      await generate(screenshot.token);
      setScreenshot(true);
    } catch (error) {
      setError(t(error instanceof Error ? error.message : String(error)));
      setBusy(false);
    }
  };
  const exportReport = async () => {
    if (!report) return;
    setBusy(true);
    try {
      const result = await window.desktop.exportSupportBundle(
        report.referenceId,
      );
      if (result.base64 && result.filename) {
        const link = document.createElement("a");
        link.href = `data:application/zip;base64,${result.base64}`;
        link.download = result.filename;
        link.click();
        setSaved(result.filename);
      } else if (result.savedPath) setSaved(result.savedPath);
    } catch (error) {
      setError(t(error instanceof Error ? error.message : String(error)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      className="support-bundle-dialog"
      title={
        saved
          ? "Report exported"
          : busy && !report
            ? "Generate Diagnostic Report"
            : "Diagnostic Report"
      }
      showClose={!busy}
      disablePointerDismissal={busy}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="support-bundle-body">
        {saved ? (
          <p>{formatText(t("Saved to {path}"), { path: saved })}</p>
        ) : (
          <>
            {busy && !report ? (
              <div role="status">{t("Collecting diagnostics…")}</div>
            ) : (
              <>
                <div>
                  <div>{t("This report contains:")}</div>
                  <ul>
                    <li>{t("App version, OS, and system info")}</li>
                    <li>{t("Recent error and warning log lines")}</li>
                    {screenshot && <li>{t("Screenshot")}</li>}
                  </ul>
                </div>
                {!screenshot && (
                  <p className="support-privacy">
                    {t(
                      "Conversations aren’t included. Some personal details in log lines are masked, but an error line can still quote text from a file or message.",
                    )}
                  </p>
                )}
                <button
                  className="support-preview-toggle"
                  aria-expanded={preview}
                  onClick={() => setPreview(!preview)}
                >
                  {t("Preview contents")}
                </button>
                {preview && (
                  <pre className="support-preview">
                    {report?.previewLines.join("\n")}
                  </pre>
                )}
                {surface === "desktop" && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void capture()}
                  >
                    {t("Capture screenshot")}
                  </button>
                )}
              </>
            )}
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="button-row">
        {saved && report && surface === "desktop" && (
          <button
            className="secondary"
            onClick={() =>
              void window.desktop.revealSupportBundle(report.referenceId)
            }
          >
            {t(
              platform === "darwin"
                ? "Show in Finder"
                : platform === "win32"
                  ? "Show in Explorer"
                  : "Show in Folder",
            )}
          </button>
        )}
        <button className="secondary" disabled={busy} onClick={onClose}>
          {t(saved ? "Done" : "Cancel")}
        </button>
        {!saved && (
          <button
            className="secondary"
            disabled={busy || !report}
            onClick={() => void exportReport()}
          >
            {t("Export to file")}
          </button>
        )}
      </div>
    </Modal>
  );
}
