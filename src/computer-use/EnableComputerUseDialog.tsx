import { useState } from "react";
import { createPortal } from "react-dom";
import type { ComputerUsePermissions } from "../../shared/computer-use-api";
import { t } from "../i18n";
import { Modal } from "../ui/Controls";
import { PermissionRow } from "./PermissionRow";
import { saveComputerUseSettings } from "./useComputerUse";

/**
 * "Turn on computer use?": what Claudex will do, the Keep in mind list and the
 * research-preview line, Cancel and Turn on; then, on a Mac still missing a
 * permission, "Grant macOS permissions" with the two rows and Done.
 */
export function EnableComputerUseDialog({
  platform,
  permissions,
  learnMore,
  onClose,
  onError,
}: {
  platform: string;
  permissions?: ComputerUsePermissions;
  learnMore?: string;
  onClose: () => void;
  onError: (error: unknown) => void;
}) {
  const [step, setStep] = useState<"warning" | "permissions">("warning");
  const [busy, setBusy] = useState(false);
  const missing =
    permissions &&
    (permissions.accessibility !== "granted" ||
      permissions.screen !== "granted");
  const turnOn = () => {
    setBusy(true);
    void saveComputerUseSettings({ enabled: true })
      .then(() => (missing ? setStep("permissions") : onClose()))
      .catch(onError)
      .finally(() => setBusy(false));
  };
  // Windows: Claudex sees the whole screen; macOS works in the background.
  const wholeScreen = platform === "win32";
  return createPortal(
    <Modal
      title={
        step === "warning" ? "Turn on computer use?" : "Grant macOS permissions"
      }
      onClose={onClose}
      className="cu-enable-dialog"
    >
      {step === "warning" ? (
        <>
          <div className="cu-enable-body">
            <p>
              {wholeScreen
                ? "Claudex will see your whole screen and use your mouse and keyboard on it. You’ll approve the apps Claudex asks for, but on this system access can’t be limited to them, and you won’t confirm each step Claudex performs."
                : "Claudex will see the apps you approve and click and type in them, working in the background while you keep using your computer or taking full control of your screen. Which of those Claudex does by default is set under Settings → This computer → Computer use. You’ll approve each app, but not confirm each step Claudex performs."}
            </p>
            <div>
              <div className="cu-enable-heading">Keep in mind:</div>
              <ul>
                <li>Some actions can’t be undone.</li>
                <li>
                  Apps you approve could open other apps that you haven’t
                  approved.
                </li>
                <li>
                  Websites and docs could contain malicious instructions that
                  misdirect Claudex.
                </li>
                <li>
                  {wholeScreen
                    ? "Close anything sensitive. Claudex can see your screen."
                    : "Close anything sensitive. Claudex can see what’s on screen in the apps you approve, and your whole screen when Claudex has full control."}
                </li>
              </ul>
            </div>
            <p>
              This is a research preview. Start with tasks where mistakes are
              easy to fix.
              {learnMore && (
                <>
                  {" "}
                  <a
                    className="cu-link"
                    href={learnMore}
                    onClick={(event) => {
                      event.preventDefault();
                      void window.desktop
                        .openExternal(learnMore)
                        .catch(onError);
                    }}
                  >
                    {t("Read safe use tips")}
                  </a>
                </>
              )}
            </p>
          </div>
          <div className="button-row">
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy}
              data-testid="confirmation-modal-confirm"
              onClick={turnOn}
            >
              Turn on
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="cu-enable-body">
            <p>
              Computer use is on. To finish setup, grant the macOS permissions
              below.
            </p>
            {permissions && (
              <div className="cu-section cu-enable-permissions">
                <PermissionRow
                  kind="accessibility"
                  label="Accessibility"
                  status={permissions.accessibility}
                  attention
                  onError={onError}
                />
                <PermissionRow
                  kind="screen"
                  label="Screen recording"
                  status={permissions.screen}
                  attention
                  onError={onError}
                />
              </div>
            )}
          </div>
          <div className="button-row">
            <button
              type="button"
              className="primary"
              autoFocus
              onClick={onClose}
            >
              Done
            </button>
          </div>
        </>
      )}
    </Modal>,
    document.body,
  );
}
