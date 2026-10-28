import { currentLocale, useLocale, t } from "../../i18n";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { SquareArrowOutUpRight } from "../../ui/glyphs";
import { AppIcon } from "../../ui/app-icon";
import type { ReportingStatus } from "../../../shared/diagnostics-api";
import { preference } from "../../../shared/settings-extras";
import type { HostedShare, SharingStatus } from "../../../shared/sharing-api";
import type { Settings } from "../../../shared/types";
import {
  Button,
  LinkRow,
  Row,
  Section,
  Toggle,
  UnavailableButton,
} from "../controls";
import type { TabProps } from "../context";
import { LocationMetadataRow } from "../LocationMetadataRow";
import {
  PrivacyExplanations,
  privacyStorageNote,
} from "../PrivacyExplanations";
import type {
  PrivacyDataAPI,
  PrivacyDataStatus,
} from "../../../shared/privacy-data-api";
import {
  usePrivacyOwner,
  usePrivacyRead,
  type PrivacyOwner,
} from "../privacy-owner";
import { SharedChatsPage, SharedArtifactsPage } from "./PrivacyShared";

const FeedbackManager = lazy(() => import("../privacy-data/FeedbackManager"));
const UploadedFilesManager = lazy(
  () => import("../privacy-data/UploadedFilesManager"),
);

/** Rows Settings search finds on this page. */
export { privacySearchLabels as searchLabels } from "../privacy-search";

/**
 * Help improve Claudex appears only while the service collects diagnostics
 * or reply feedback (owner decision 1); `null` (local accounts, services
 * without collection) shows nothing.
 */
export function collectsReports(status: ReportingStatus | null | undefined) {
  return Boolean(status && (status.diagnostics || status.feedback));
}

export const helpImproveNote =
  "Send error reports and your feedback on replies to your Claudex service. They never include your prompts; a conversation is only sent when you choose to include it with feedback.";

export const nonessentialServicesDescription =
  "Connector favicons, artifact-preview and MCP Apps iframes, and the Linux spellcheck dictionary. Connector widgets fall back to text; spellcheck is off on Linux.";
export const nonessentialServicesWarning =
  "This disables connector icons, hosted artifact previews and MCP Apps widgets, and also turns spellcheck off on Linux. Artifacts still render locally. Connectors that return MCP Apps show the text tool result instead of the widget.";

/**
 * Privacy. Only what Claudex does: data stays on this computer, the consent
 * switch for the service's collection, the export and the links shared from it:
 * Shared chats while the Claudex service hosts shared conversations (R1),
 * Shared artifacts for links on this computer and public ones. Location
 * metadata is resolved by the service.
 */
export function PrivacyTab(props: TabProps) {
  const owner = usePrivacyOwner();
  return <PrivacyPage key={owner.id} {...props} owner={owner} />;
}

function PrivacyPage({
  settings,
  save,
  onError,
  goTo,
  owner,
}: TabProps & { owner: PrivacyOwner }) {
  useLocale();
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const reporting = usePrivacyRead(
    owner,
    (bridge) => bridge.reportingStatus(),
    onError,
  );
  // A failed status read only hides Shared chats: the row is optional.
  const sharing = usePrivacyRead(
    owner,
    (bridge) => bridge.sharingStatus().catch(() => null),
    onError,
  );
  // Terms belong to the same service as reporting/sharing and are re-read
  // with the Privacy owner after a service/account change.
  const terms = usePrivacyRead(
    owner,
    (bridge) =>
      bridge
        .signUpProfile()
        .then((profile) => profile?.termsUrl ?? null)
        .catch(() => null),
    onError,
  );
  const privacyData = usePrivacyRead<PrivacyDataStatus>(
    owner,
    (bridge) => {
      const api = bridge as typeof bridge & Partial<PrivacyDataAPI>;
      return api.privacyDataStatus
        ? api.privacyDataStatus()
        : Promise.resolve({
            feedback: { supported: false, reason: "unsupported-host" },
            uploads: { supported: false, reason: "unsupported-host" },
          });
    },
    onError,
  );
  const [exported, setExported] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const [managing, setManaging] = useState<
    "chats" | "artifacts" | "feedback" | "uploads"
  >();
  // Back from a subpage returns focus to its Manage button.
  const chatsButton = useRef<HTMLButtonElement>(null);
  const artifactsButton = useRef<HTMLButtonElement>(null);
  const feedbackButton = useRef<HTMLButtonElement>(null);
  const uploadsButton = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<"chats" | "artifacts" | "feedback" | "uploads">(
    undefined,
  );
  useEffect(() => {
    if (managing || !returnTo.current) return;
    (returnTo.current === "chats"
      ? chatsButton
      : returnTo.current === "feedback"
        ? feedbackButton
        : returnTo.current === "uploads"
          ? uploadsButton
          : artifactsButton
    ).current?.focus();
    returnTo.current = undefined;
  }, [managing]);
  const back = () => {
    returnTo.current = managing;
    setManaging(undefined);
  };
  // Manage shows the list in place of the page, with "← Privacy" to come back.
  if (managing === "chats")
    return <SharedChatsPage owner={owner} onBack={back} onError={onError} />;
  if (managing === "artifacts")
    return (
      <SharedArtifactsPage
        owner={owner}
        hosted={Boolean(sharing.value)}
        onBack={back}
        onError={onError}
      />
    );
  if (managing === "feedback" || managing === "uploads")
    return (
      <Suspense fallback={<p role="status">{t("Loading…")}</p>}>
        {managing === "feedback" ? (
          <FeedbackManager owner={owner} onBack={back} onError={onError} />
        ) : (
          <UploadedFilesManager owner={owner} onBack={back} onError={onError} />
        )}
      </Suspense>
    );
  return (
    <>
      <Section title="Privacy" headingLevel={2} note={privacyStorageNote}>
        <PrivacyExplanations />
        {terms.value && (
          <LinkRow
            label="Terms of Service"
            onOpen={() =>
              owner.current() &&
              void owner.bridge?.openExternal(terms.value!).catch((error) => {
                if (owner.current()) onError(error);
              })
            }
          />
        )}
      </Section>
      <PreferencesSection
        status={reporting.value}
        settings={settings}
        save={save}
      />
      <Section title="Your data">
        <Row
          label="Export data"
          description={
            // The original's row has no description; only the result shows.
            exported ? `Saved to ${exported}` : undefined
          }
        >
          <Button
            size="regular"
            disabled={exporting}
            onClick={() => {
              if (!owner.current() || !owner.bridge) return;
              setExporting(true);
              owner.bridge
                .exportData()
                .then((file) => {
                  if (live.current && owner.current() && file)
                    setExported(file);
                })
                .catch((error) => {
                  if (live.current && owner.current()) onError(error);
                })
                .finally(() => {
                  if (live.current && owner.current()) setExporting(false);
                });
            }}
          >
            Export data
          </Button>
        </Row>
        <Row label="Shared chats">
          {showsSharedChats(sharing.value) ? (
            <Button
              ref={chatsButton}
              size="regular"
              onClick={() => setManaging("chats")}
            >
              Manage
            </Button>
          ) : (
            <UnavailableButton size="regular" reason={noHostedSharing}>
              Manage
            </UnavailableButton>
          )}
        </Row>
        <Row label="Shared artifacts">
          <Button
            ref={artifactsButton}
            size="regular"
            onClick={() => setManaging("artifacts")}
          >
            Manage
          </Button>
        </Row>
        {/* The original's other data rows. */}
        <Row label="Uploaded files">
          <Button
            ref={uploadsButton}
            size="regular"
            disabled={!privacyData.value?.uploads.supported}
            onClick={() => setManaging("uploads")}
          >
            Manage
          </Button>
        </Row>
        <Row label="Your feedback">
          <Button
            ref={feedbackButton}
            size="regular"
            disabled={!privacyData.value?.feedback.supported}
            onClick={() => setManaging("feedback")}
          >
            Manage
          </Button>
        </Row>
        {privacyData.failed ? (
          <div role="alert">
            <p>{t("Couldn’t check privacy data support.")}</p>
            <Button onClick={() => void privacyData.reload()}>
              {t("Retry")}
            </Button>
          </div>
        ) : !privacyData.value ? (
          <p role="status">{t("Checking privacy data support…")}</p>
        ) : (
          <>
            {!privacyData.value.feedback.supported && (
              <p className="settings-section-note">
                {t(
                  privacyData.value.feedback.reason === "local-account"
                    ? "Local accounts have no service feedback history."
                    : privacyData.value.feedback.reason === "unsupported-host"
                      ? "Feedback history management is unavailable in this app."
                      : "This service does not support feedback history management.",
                )}
              </p>
            )}
            {!privacyData.value.uploads.supported && (
              <p className="settings-section-note">
                {t("This host cannot list stored attachment copies.")}
              </p>
            )}
          </>
        )}
        <Row label="Memory preferences">
          <Button size="regular" onClick={() => goTo("memory")}>
            Manage
            <SquareArrowOutUpRight
              size={20}
              strokeWidth={1.5}
              aria-hidden="true"
            />
          </Button>
        </Row>
      </Section>
    </>
  );
}

/** Preferences and the Telemetry service block. */
export function PreferencesSection({
  status,
  settings,
  save,
}: {
  status: ReportingStatus | null | undefined;
  settings: Settings;
  save: TabProps["save"];
}) {
  // The original's two switches. Claudex sends no location; the consent is
  // there to give only while the service collects (owner decision 1), and is
  // drawn off and disabled otherwise (UI first).
  const collects = collectsReports(status);
  const blocked = preference(settings, "disableNonessentialServices");
  return (
    <Section title="Preferences">
      <LocationMetadataRow settings={settings} save={save} />
      <Row label="Help improve Claudex" description={helpImproveNote}>
        <Toggle
          label="Help improve Claudex"
          checked={collects && preference(settings, "helpImproveClaudex")}
          unavailable={collects ? undefined : notCollecting}
          onChange={(helpImproveClaudex) => save({ helpImproveClaudex })}
        />
      </Row>
      <div
        className={`nonessential-services-row${blocked ? " nonessential-services-blocked" : ""}`}
        data-setting="Block nonessential services"
      >
        <div className="nonessential-services-text">
          <div className="nonessential-services-label">
            {t("Block nonessential services")}
          </div>
          <p id="nonessential-services-description">
            {t(nonessentialServicesDescription)}
          </p>
          {blocked && (
            <div
              className="nonessential-services-warning"
              id="nonessential-services-warning"
            >
              <span className="nonessential-services-warning-icon">
                <AppIcon name="Warning" size={16} aria-hidden="true" />
              </span>
              <span>{t(nonessentialServicesWarning)}</span>
            </div>
          )}
        </div>
        <Toggle
          label="Block nonessential services"
          checked={blocked}
          describedBy={`nonessential-services-description${blocked ? " nonessential-services-warning" : ""}`}
          onChange={(disableNonessentialServices) =>
            save({ disableNonessentialServices })
          }
        />
      </div>
    </Section>
  );
}

/** Why Help improve Claudex is off and disabled. */
export const notCollecting =
  "Your Claudex service doesn’t collect error reports or feedback.";

/**
 * Shared chats shows while the service hosts shared conversations, and also
 * while the administrator blocked new shares for the account: existing
 * links can still be listed and stopped then. `null` (local account, no
 * hosted sharing, sharing turned off) hides it.
 */
export function showsSharedChats(status: SharingStatus | null | undefined) {
  return Boolean(status && (status.conversations || status.blocked));
}

/** Why Shared chats has nothing to manage. */
export const noHostedSharing =
  "Your Claudex service doesn’t host shared chats for this account.";

export function sharedArtifactsNote(hosted: boolean) {
  return hosted
    ? "Links you made to artifacts: public ones, and ones that open only on this computer."
    : "Links you made to artifacts. They open only on this computer.";
}

/**
 * "Sep 26, 2026": the Date shared and Date published columns; "—" when the date
 * isn't known.
 */
export function sharedDate(time: number | undefined) {
  if (!time) return "—";
  return new Date(time).toLocaleDateString(currentLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** What the second line says for a chat taken down by the administrator. */
export function removedDetail(share: HostedShare) {
  return share.disabledReason
    ? `Removed by the administrator: ${share.disabledReason}`
    : "Removed by the administrator";
}

/**
 * Who can open a shared chat, under its name; a chat the administrator took
 * down says so instead.
 */
export function sharedChatAudience(share: HostedShare) {
  if (share.status !== "active") return removedDetail(share);
  return share.access === "invited"
    ? "Only people invited"
    : "Anyone with the link";
}
