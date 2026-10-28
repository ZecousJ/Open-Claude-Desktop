import { helpUrl } from "../../../shared/help-links";
import { formatText, t, useT } from "../../i18n";
import { showToast } from "../../ui/toast-store";
import { AccountPasskey } from "./AccountPasskey";
import { Suspense, useEffect, useRef, useState } from "react";
import { AccountAvatar } from "../AccountAvatar";
import { workTypes, type WorkType } from "../../../shared/settings-extras";
import { Skeleton, SkeletonGroup } from "../../ui/Skeleton";
import type { AccountProfile } from "../../../shared/settings-api";
import { ConfirmationDialog } from "../../dialogs/ConfirmationDialog";
import { Button, Row, Section, TextField } from "../controls";
import { Dropdown } from "../Dropdown";
import { ActiveSessionsSection } from "../ActiveSessions";
// The Account page's last section, kept importable from here.
export { ActiveSessionsSection };
import { InstructionsField } from "../InstructionsField";
import type { TabProps } from "../context";
import { createPortal } from "react-dom";
import "../original-rows.css";
import "./account-parity.css";
import { lazyPiece } from "../../ui/lazy-piece";
import { useSettingsRequestScope } from "../useSettingsRequestScope";

import { useAccountRead } from "../useAccountRead";

const AccountDeviceSettings = lazyPiece(
  () => import("./AccountTrustedDevices"),
  "AccountDeviceSettings",
);

const DeleteAccountDialog = lazyPiece(
  () => import("./DeleteAccountDialog"),
  "DeleteAccountDialog",
);

/** Rows Settings search finds on this page. */
export const searchLabels = [
  "Profile",
  "Profile photo",
  "Avatar",
  "Display name",
  "Local devices",
  "Require trusted devices",
  "Trusted devices",
  "Full name",
  "What should Claudex call you?",
  "What best describes your work?",
  "Instructions for Claudex",
  "Log out of all devices",
  "Log out of this device",
  "Delete account",
  "Active sessions",
];

/** The suggestions the empty Instructions box cycles through. */
const instructionPlaceholders = [
  "e.g. keep explanations brief and to the point",
  "e.g. when learning new concepts, I find analogies particularly helpful",
  "e.g. ask clarifying questions before giving detailed answers",
  "e.g. I primarily code in Python (not a coding beginner)",
];

/** Explanation for a service account whose profile disallows deletion. */
export const administratorDeletesNote =
  "Your administrator manages this account. Contact them to delete it.";

/** The captured Account photo flow limits picked files, independently of the
 * existing bridge's larger supported upload envelope. */
export const accountPhotoLimit = 10 * 1024 * 1024;

const isProfile = (value: unknown): value is AccountProfile =>
  !!value &&
  typeof value === "object" &&
  "kind" in value &&
  (value.kind === "local" || value.kind === "remote") &&
  "fullName" in value &&
  typeof value.fullName === "string" &&
  "email" in value &&
  typeof value.email === "string" &&
  "canDelete" in value &&
  typeof value.canDelete === "boolean";

/**
 * Account. No Organization ID row (owner decision 12): a Claudex account has no
 * organization to show.
 */
export function AccountTab({
  settings,
  save,
  onSignOut,
  onSignOutEverywhere,
  onError,
}: TabProps) {
  const requests = useSettingsRequestScope();
  const profile = useAccountRead(
    (bridge) => bridge.accountProfile(),
    isProfile,
    onError,
  );
  const savingName = useRef(false);
  const [nameBusy, setNameBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const avatarOwner = useRef({ owner: profile.owner, key: 0 });
  if (avatarOwner.current.owner !== profile.owner)
    avatarOwner.current = {
      owner: profile.owner,
      key: avatarOwner.current.key + 1,
    };
  useEffect(() => {
    savingName.current = false;
    setNameBusy(false);
    setDeleting(false);
    setConfirmingSignOut(false);
  }, [profile.owner]);
  const fullName = profile.value?.fullName ?? "";
  return (
    <div className="settings-account">
      <Section title="Profile">
        <Row
          label="Profile photo"
          description={formatText("PNG, JPEG, or WebP, up to {size}MB.", {
            size: accountPhotoLimit / (1024 * 1024),
          })}
        >
          <AccountAvatar
            key={avatarOwner.current.key}
            settings={{ ...settings, profilePhotoEnabled: true }}
            name={fullName || settings.name}
            save={save}
            uploadLimit={accountPhotoLimit}
          />
        </Row>
        <Row label="Full name">
          {profile.loading ? (
            <SkeletonGroup
              label="Loading profile"
              className="account-profile-loading"
            >
              <Skeleton width={96} height={28} />
            </SkeletonGroup>
          ) : profile.failed ? (
            <div role="alert" className="account-profile-error">
              <span>Couldn’t load your profile.</span>
              <Button onClick={() => void profile.reload()}>Retry</Button>
            </div>
          ) : profile.value ? (
            <fieldset disabled={nameBusy} className="account-profile-field">
              <TextField
                label="Full name"
                value={fullName}
                onCommit={(name) => {
                  const next = name.trim();
                  const bridge = profile.owner.bridge;
                  if (
                    !next ||
                    next === fullName ||
                    !bridge ||
                    !profile.current() ||
                    savingName.current
                  )
                    return;
                  savingName.current = true;
                  setNameBusy(true);
                  void bridge
                    .setFullName(next)
                    .then((saved) => {
                      if (!profile.current()) return;
                      if (!isProfile(saved))
                        throw new Error("Invalid account response");
                      profile.setValue(saved);
                      showToast(t("Saved"));
                    })
                    .catch(() => {
                      if (profile.current())
                        showToast(t("Couldn’t save that change"));
                    })
                    .finally(() => {
                      if (profile.current()) {
                        savingName.current = false;
                        setNameBusy(false);
                      }
                    });
                }}
              />
            </fieldset>
          ) : null}
        </Row>
        <Row label="What should Claudex call you?">
          <TextField
            label="Display name"
            value={settings.name}
            onCommit={(name) => {
              const request = requests.capture();
              if (!name.trim() || !request.current()) return;
              void Promise.resolve(
                save({ name: name.trim() }, "Couldn’t save that change"),
              ).then(
                (kept) => kept && request.current() && showToast(t("Saved")),
              );
            }}
          />
        </Row>
        <Row label="What best describes your work?">
          <Dropdown<WorkType>
            label="What best describes your work?"
            value={settings.workType}
            placeholder="Select"
            options={workTypes}
            onChange={(workType) => {
              const request = requests.capture();
              if (!request.current()) return;
              save({ workType });
              // The service keeps the same work type as the onboarding's
              // answer (shared/onboarding-api.ts); a courtesy, never an error.
              void Promise.resolve()
                .then(() =>
                  request.current()
                    ? request.bridge?.saveOnboarding({ workFunction: workType })
                    : undefined,
                )
                .catch(() => {});
            }}
          />
        </Row>
        <Row
          stacked
          label="Instructions for Claudex"
          description={<InstructionsDescription />}
        >
          <InstructionsField
            key={avatarOwner.current.key}
            label="Instructions for Claudex"
            placeholders={instructionPlaceholders}
            value={settings.instructions}
            onSave={(instructions) => {
              if (requests.capture().current()) save({ instructions });
            }}
          />
        </Row>
      </Section>
      <AccountSection
        profile={profile.value}
        loading={profile.loading}
        onSignOut={onSignOut && (() => void onSignOut().catch(onError))}
        onSignOutEverywhere={
          onSignOutEverywhere && (() => setConfirmingSignOut(true))
        }
        onDelete={() => setDeleting(true)}
      />
      <Suspense fallback={null}>
        <AccountDeviceSettings
          key={avatarOwner.current.key}
          onError={onError}
        />
      </Suspense>
      {/* After the trusted devices, as on the live web. */}
      <AccountPasskey />
      <ActiveSessionsSection
        key={avatarOwner.current.key}
        onSignOut={onSignOut}
        onError={onError}
      />
      {confirmingSignOut &&
        onSignOutEverywhere &&
        createPortal(
          <ConfirmationDialog
            confirmation={{
              title: "Log out of all devices",
              body: "Are you sure you want to log out of all devices?",
              confirm: "Log out of all devices",
              danger: false,
              action: onSignOutEverywhere,
            }}
            onClose={() => setConfirmingSignOut(false)}
            onError={onError}
          />,
          document.body,
        )}
      {deleting && profile.value && (
        <Suspense fallback={null}>
          <DeleteAccountDialog
            onClose={() => setDeleting(false)}
            onDeleted={
              onSignOut ??
              (() => {
                location.assign("/login");
              })
            }
          />
        </Suspense>
      )}
    </div>
  );
}

/**
 * The Account section. Both local and remote accounts delete themselves using
 * their active session.
 */
export function AccountSection({
  profile,
  loading = false,
  onSignOut,
  onSignOutEverywhere,
  onDelete,
}: {
  profile: AccountProfile | undefined;
  loading?: boolean;
  onSignOut?: () => void;
  onSignOutEverywhere?: () => void;
  onDelete: () => void;
}) {
  return (
    <Section title="Account">
      {onSignOutEverywhere ? (
        <Row label="Log out of all devices">
          <Button size="compact" onClick={onSignOutEverywhere}>
            Log out
          </Button>
        </Row>
      ) : (
        onSignOut && (
          <Row label="Log out of this device">
            <Button onClick={onSignOut}>Log out</Button>
          </Row>
        )
      )}
      {loading && (
        <Row label={<Skeleton width={136} height={14} />}>
          <SkeletonGroup label="Loading account">
            <Skeleton width={125} height={32} />
          </SkeletonGroup>
        </Row>
      )}
      {profile &&
        (profile.canDelete ? (
          // The reference design row for an account that can delete itself:
          // "Delete your account" and a primary Delete account button. What it
          // removes is said in the dialog.
          <Row label="Delete your account">
            <Button primary size="regular" onClick={onDelete}>
              Delete account
            </Button>
          </Row>
        ) : (
          <Row label="Delete account">
            <span className="settings-delete-managed">
              {administratorDeletesNote}
            </span>
          </Row>
        ))}
    </Section>
  );
}

export function InstructionsDescription() {
  useT();
  return (
    <span data-no-translate>
      {formatText(
        "Claudex will keep these in mind for this and any of your associated accounts across chats within {guidelines}. {learnMore}",
        { guidelines: "\u0001", learnMore: "\u0002" },
      )
        .split(/(\u0001|\u0002)/)
        .map((part, index) =>
          part === "\u0001" ? (
            <a
              key={index}
              href={helpUrl("usage-policy")}
              target="_blank"
              rel="noreferrer"
            >
              {t("Claudex usage policy")}
            </a>
          ) : part === "\u0002" ? (
            <a
              key={index}
              href={helpUrl("personalization")}
              target="_blank"
              rel="noreferrer"
            >
              {t("Learn more")}
            </a>
          ) : (
            part
          ),
        )}
    </span>
  );
}
