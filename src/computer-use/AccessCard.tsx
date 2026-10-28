import { currentLocale, formatText, t, useT } from "../i18n";
import { useState } from "react";
import { createPortal } from "react-dom";
import { Modal } from "../ui/Controls";
import { AppIcon } from "../ui/app-icon";
import type {
  ComputerUseAccessRequest,
  ComputerUsePermissions,
} from "../../shared/computer-use-api";
import {
  ApprovalActions,
  useApprovalShortcuts,
  type ApprovalHandlers,
} from "../approval/ApprovalActions";
import { tierLabels } from "./labels";
import { sentinelKind, sentinelWarnings } from "./sentinel";
import { PermissionRow } from "./PermissionRow";

/**
 * The title of an access request's card: one app is named, several are listed
 * below "wants to use:", and full control asks for the whole computer.
 */
export function accessTitle(request: ComputerUseAccessRequest) {
  if (request.kind === "permissions") return t("System permissions needed");
  if (request.kind === "full-control") return takeoverTitle(request);
  if (!request.apps.length)
    return request.clipboard
      ? t("Claudex wants to:")
      : t("Claudex wants to use your computer");
  if (request.apps.length === 1 && request.clipboard)
    return t("Claudex wants to use:");
  return request.apps.length === 1
    ? formatText("Claudex wants to use {appName}", {
        appName: request.apps[0].app.name,
      })
    : t("Claudex wants to use:");
}

/**
 * Full control asked for while Claudex works in the background: the apps it was
 * working in, or the preferred background mode, then whether to take over the
 * screen.
 */
export function takeoverTitle(request: ComputerUseAccessRequest) {
  const names = request.apps.map((item) => item.app.name);
  if (!names.length)
    return t(
      "Take over the screen? You’ve set Background as your preferred mode, so Claudex is checking before switching to full-screen control.",
    );
  return formatText(
    "Take over the screen? Claudex was working on {appName} in the background and now needs full-screen control.",
    { appName: conjunction(names) },
  );
}

function conjunction(names: string[]) {
  try {
    return new Intl.ListFormat(currentLocale(), {
      type: "conjunction",
    }).format(names);
  } catch {
    return names.join(", ");
  }
}

/** The answer the card sends: every app it lists, at the level proposed. */
export function accessAnswer(request: ComputerUseAccessRequest): {
  allow: string[];
  deny: string[];
} {
  return { allow: request.apps.map((item) => item.app.id), deny: [] };
}

/**
 * Claudex asks, from a running turn, to use apps in this conversation or to
 * take control of the screen. Docked above the composer like Codex's requests,
 * with their keys (1 or Esc denies, 3 or ⌘↩ allows). Access lasts for this
 * conversation only; nothing is remembered across chats. As the original's
 * card: the Interactive glyph and title, then the apps in one bordered list,
 * each with its icon, name and the proposed level (no choosing per app), a
 * warning under apps that reach beyond themselves, how Claudex will work, and
 * Deny / Allow for this session.
 */
export function AccessCard({
  request,
  frontmost,
  mac,
  canHideApps,
  background = false,
  unhide = false,
  permissions,
  onError,
}: {
  request: ComputerUseAccessRequest;
  frontmost: boolean;
  mac: boolean;
  canHideApps: boolean;
  /** Background is the preferred mode (the first allow introduces it). */
  background?: boolean;
  /** Hidden apps come back when Claudex finishes (Settings). */
  unhide?: boolean;
  /** The macOS permissions, for a "permissions" request. */
  permissions?: ComputerUsePermissions;
  onError: (error: unknown) => void;
}) {
  if (request.kind === "permissions")
    return (
      <PermissionsCard
        request={request}
        frontmost={frontmost}
        mac={mac}
        permissions={permissions}
        onError={onError}
      />
    );
  if (request.kind === "full-control")
    return (
      <TakeoverCard
        request={request}
        frontmost={frontmost}
        mac={mac}
        onError={onError}
      />
    );
  return (
    <AppsCard
      request={request}
      frontmost={frontmost}
      mac={mac}
      canHideApps={canHideApps}
      background={background}
      unhide={unhide}
      onError={onError}
    />
  );
}

/** Sends the person's answer; a failure is reported and the card stays. */
function useAnswer(
  request: ComputerUseAccessRequest,
  onError: (error: unknown) => void,
) {
  const [busy, setBusy] = useState(false);
  const send = async (
    decision: { allow: string[]; deny: string[] } | "deny",
  ) => {
    setBusy(true);
    try {
      await window.desktop.answerComputerUseAccess(request.id, decision);
    } catch (error) {
      onError(error);
      setBusy(false);
    }
  };
  return { busy, send };
}

function AppsCard({
  request,
  frontmost,
  mac,
  canHideApps,
  background,
  unhide,
  onError,
}: {
  request: ComputerUseAccessRequest;
  frontmost: boolean;
  mac: boolean;
  canHideApps: boolean;
  background: boolean;
  unhide: boolean;
  onError: (error: unknown) => void;
}) {
  const t = useT();
  const { busy, send } = useAnswer(request, onError);
  // The first allow in background mode on a Mac explains it first.
  const [introducing, setIntroducing] = useState(false);
  const handlers: ApprovalHandlers = {
    deny: () => !busy && void send("deny"),
    once: () => {
      if (busy || introducing) return;
      if (mac && background && !backgroundIntroSeen())
        return setIntroducing(true);
      void send(accessAnswer(request));
    },
  };
  useApprovalShortcuts(frontmost && !busy, handlers, mac);
  const title = accessTitle(request);
  // How Claudex will work in the apps (the original's _e notes).
  const note = !request.apps.length
    ? null
    : background
      ? mac
        ? t(
            "Claudex will work in these apps in the background while you keep using your Mac.",
          )
        : null
      : canHideApps
        ? unhide
          ? t(
              "Your other windows will be hidden, then restored when Claudex is done.",
            )
          : t("Your other windows will be hidden while Claudex works.")
        : null;
  const clipboard = request.clipboard;
  return (
    <section
      className="approval-card cu-access-card"
      aria-label={title}
      data-kind="computer-use"
      aria-busy={busy || undefined}
    >
      <div className="cu-access-head">
        <AppIcon name="Interactive" />
        <h3 data-no-translate className="cu-access-title">
          {title}
        </h3>
      </div>
      <div className="cu-access-body">
        {request.reason && (
          <p className="approval-text cu-access-reason">
            <span>Claudex says: </span>
            <span data-no-translate>{request.reason}</span>
          </p>
        )}
        {(request.apps.length > 0 || clipboard) && (
          <ul className="cu-access-apps" aria-label="Apps">
            {request.apps.map((item) => {
              const kind = sentinelKind(item.app);
              return (
                <li key={item.app.id}>
                  <div className="cu-access-row">
                    {item.icon ? (
                      <span className="cu-access-icon">
                        <img src={item.icon} alt="" />
                      </span>
                    ) : (
                      <span
                        className="cu-access-icon cu-access-icon-blank"
                        aria-hidden="true"
                      />
                    )}
                    <span data-no-translate className="cu-access-name">
                      {item.app.name}
                    </span>
                    <span className="cu-tier" data-tier={item.tier}>
                      {tierLabels[item.tier]}
                    </span>
                  </div>
                  {kind && (
                    <div className="cu-access-warning">
                      <AppIcon name="Warning" />
                      <span>{sentinelWarnings[kind]}</span>
                    </div>
                  )}
                </li>
              );
            })}
            {clipboard?.read && (
              <li>
                <div className="cu-access-row">
                  <span className="cu-access-icon cu-access-icon-glyph">
                    <AppIcon name="Clipboard" />
                  </span>
                  <span className="cu-access-name">Read your clipboard</span>
                </div>
              </li>
            )}
            {clipboard?.write && (
              <li>
                <div className="cu-access-row">
                  <span className="cu-access-icon cu-access-icon-glyph">
                    <AppIcon name="Copy" />
                  </span>
                  <span className="cu-access-name">
                    Write to your clipboard
                  </span>
                </div>
              </li>
            )}
          </ul>
        )}
        {note && <p className="cu-access-note">{note}</p>}
        {!!request.deniedAutomatically?.length && (
          <p className="cu-access-denied">
            Denied automatically:{" "}
            {request.deniedAutomatically.map((app) => app.name).join(", ")}
          </p>
        )}
      </div>
      <ApprovalActions
        handlers={handlers}
        busy={busy}
        mac={mac}
        onceLabel="Allow for this session"
      />
      {introducing && (
        <BackgroundIntro
          onContinue={() => {
            setIntroducing(false);
            rememberBackgroundIntro();
            void send(accessAnswer(request));
          }}
          onClose={() => setIntroducing(false)}
        />
      )}
    </section>
  );
}

/**
 * Full control asked for in background mode: the 16px Interactive glyph and the
 * question in semibold primary text, then Stay in background and Allow.
 */
function TakeoverCard({
  request,
  frontmost,
  mac,
  onError,
}: {
  request: ComputerUseAccessRequest;
  frontmost: boolean;
  mac: boolean;
  onError: (error: unknown) => void;
}) {
  const { busy, send } = useAnswer(request, onError);
  const handlers: ApprovalHandlers = {
    deny: () => !busy && void send("deny"),
    once: () => !busy && void send(accessAnswer(request)),
  };
  useApprovalShortcuts(frontmost && !busy, handlers, mac);
  const title = accessTitle(request);
  return (
    <section
      className="approval-card cu-access-card cu-takeover-card"
      aria-label={title}
      data-kind="computer-use-full-control"
      aria-busy={busy || undefined}
    >
      <div className="cu-takeover-head">
        <AppIcon name="InteractiveSmall" />
        <p data-no-translate className="cu-takeover-title">
          {title}
        </p>
      </div>
      {request.reason && (
        <p className="approval-text cu-access-reason cu-takeover-reason">
          <span>Claudex says: </span>
          <span data-no-translate>{request.reason}</span>
        </p>
      )}
      <ApprovalActions
        handlers={handlers}
        busy={busy}
        mac={mac}
        denyLabel="Stay in background"
        onceLabel="Allow"
      />
    </section>
  );
}

/**
 * The macOS permissions are missing: System permissions needed, the two
 * permissions with Open System Settings, and Deny; once both are granted, Ask
 * again.
 */
function PermissionsCard({
  request,
  frontmost,
  mac,
  permissions,
  onError,
}: {
  request: ComputerUseAccessRequest;
  frontmost: boolean;
  mac: boolean;
  permissions?: ComputerUsePermissions;
  onError: (error: unknown) => void;
}) {
  const { busy, send } = useAnswer(request, onError);
  const ready =
    permissions?.accessibility === "granted" &&
    permissions?.screen === "granted";
  const handlers: ApprovalHandlers = {
    deny: () => !busy && void send("deny"),
    once: () => ready && !busy && void send("deny"),
    digits: false,
  };
  useApprovalShortcuts(frontmost && !busy, handlers, mac);
  return (
    <section
      className="approval-card cu-access-card"
      aria-label="System permissions needed"
      data-kind="computer-use-permissions"
      aria-busy={busy || undefined}
    >
      <div className="cu-access-head">
        <AppIcon name="Interactive" />
        <h3 className="cu-access-title">System permissions needed</h3>
      </div>
      <div className="cu-access-body">
        <p className="cu-access-note">
          Computer use needs two macOS permissions. Click each one, grant it in
          System Settings, then come back here.
        </p>
        {permissions && (
          <div className="cu-section cu-access-permissions">
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
        {ready && (
          <p className="cu-access-ready">
            Permissions are ready. Click Ask again to continue.
          </p>
        )}
      </div>
      <ApprovalActions
        handlers={handlers}
        busy={busy}
        mac={mac}
        onceLabel="Ask again"
        onceDisabled={!ready}
      />
    </section>
  );
}

const introKey = "claudex.computerUseBackgroundIntroSeen";
function backgroundIntroSeen() {
  try {
    return localStorage.getItem(introKey) === "true";
  } catch {
    return false;
  }
}
function rememberBackgroundIntro() {
  try {
    localStorage.setItem(introKey, "true");
  } catch {
    // Shown again next time, no more.
  }
}

function BackgroundIntro({
  onContinue,
  onClose,
}: {
  onContinue: () => void;
  onClose: () => void;
}) {
  return createPortal(
    <Modal
      title="Background computer use"
      titleIcon={<span className="cu-badge">Beta</span>}
      className="cu-intro-dialog"
      onClose={onClose}
    >
      <p className="confirm-body">
        Claudex can now control your applications in the background without
        taking over your screen, and will ask your permission if Claudex needs
        full control of your mouse and keyboard. If you’d prefer Claudex to
        default to full control instead of background mode, you can change this
        at any time under Settings → This computer → Computer use.
      </p>
      <div className="button-row">
        <button type="button" className="secondary" autoFocus onClick={onClose}>
          Not now
        </button>
        <button type="button" className="primary" onClick={onContinue}>
          Continue
        </button>
      </div>
    </Modal>,
    document.body,
  );
}
