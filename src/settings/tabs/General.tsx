import { Suspense, useEffect, useState, useSyncExternalStore } from "react";
import { lazyPiece } from "../../ui/lazy-piece";
import type { Settings } from "../../../shared/types";
import type { ArtifactMailPreferences } from "../../../shared/sharing-api";
import { preference } from "../../../shared/settings-extras";
import { surface } from "../../../shared/host";
import { useHost } from "../../host/HostContext";
import {
  useSettingsRequestScope,
  type SettingsRequestScope,
  type SettingsScopeOwner,
} from "../useSettingsRequestScope";
import { freezeLevels } from "../../../shared/notification-levels";
import { enableDesktopNotifications } from "../../../shared/desktop-notifications";
import { Row, Section, Toggle } from "../controls";
import type { TabProps } from "../context";
import { RemoteFoldersRow } from "./RemoteFolders";
import { useHoverPreview, useVoicePreview } from "../voice-preview";
import { t } from "../../i18n";
import "../voice-preferences.css";
import { showToast } from "../../ui/toast-store";
import {
  askNotificationPermission,
  permissionRefusal,
  notificationsAvailable,
} from "../../app/web-notifications";
import { browserRecognitionChosen } from "../../voice/browser-recognition";
import { canSpeak, loadVoices, speechPreferences } from "../../voice/speech";
import { SettingsVoice } from "./SettingsVoice";
import { GeneralAppearance } from "./GeneralAppearance";

export const TranscriptAppearance = lazyPiece(
  () => import("./TranscriptAppearance"),
  "TranscriptAppearance",
);
const TasksSection = lazyPiece(() => import("./Tasks"), "TasksSection");

// Each choice previews in its own face.
export const serif = {
  fontFamily: 'Georgia, "Songti SC", serif',
};
export const sans = {
  fontFamily: '-apple-system, "Segoe UI", sans-serif',
};
export const system = { fontFamily: "system-ui, sans-serif" };
export const dyslexia = {
  fontFamily: '"OpenDyslexic", "Comic Sans MS", ui-serif, Georgia, serif',
};

/**
 * The Serif and Sans choices are the original's Anthropic Serif and
 * Anthropic Sans when a local Claude installation lends those faces
 * (main.tsx loadReferenceFonts); without them the choices draw system
 * faces and say so by their plain names.
 */
export const chatFontLabels = { serif: "Serif", sans: "Sans" };

/** Rows Settings search finds on this page. */
export const searchLabels = [
  "Appearance",
  "Theme",
  "Chat font",
  "Transcript text size",
  "Transcript width",
  "Tasks",
  "Trusted Cowork folders",
  "Preferred browser",
  "Motion",
  "Voice",
  "Language",
  "Style",
  "Speed",
  "Speech recognition",
  "Notifications",
  "Response completions",
  "Scheduled tasks",
  "Code notifications",
  "Code permission requests",
  "Emails from Claudex Code cloud sessions",
  "Mentions and replies",
  "Comments on your artifacts",
  "Artifacts shared with you",
  "Sync",
  "Sync with the web",
  "Control from your phone",
  "Folders for your phone",
];

/**
 * General. Appearance and the notifications the desktop integration sends. The
 * interface is English only. Voice sets how voice mode reads a reply aloud,
 * with this window's own speech synthesis: the choices are kept in this
 * browser, since the voices are the computer's.
 */
export function GeneralTab({ settings, save, onError }: TabProps) {
  const fontLabels = chatFontLabels;
  return (
    <>
      <GeneralAppearance
        fontLabels={fontLabels}
        save={save}
        settings={settings}
      />
      <Suspense fallback={null}>
        <TasksSection settings={settings} save={save} onError={onError} />
      </Suspense>
      {canSpeak() && <VoiceSection />}
      <NotificationsSection settings={settings} save={save} />
      {surface === "desktop" && (
        <SyncSection settings={settings} save={save} onError={onError} />
      )}
    </>
  );
}

/** Sync with the web (docs/cloud-sync.md): the desktop's switch. */
export function SyncSection({
  settings,
  save,
  onError = () => {},
}: {
  settings: Settings;
  save: TabProps["save"];
  onError?: (error: unknown) => void;
}) {
  return (
    <Section title="Sync">
      <Row
        label="Sync with the web"
        description="Chats and Code sessions that use a GitHub repository run in the cloud and show on the web too. Code sessions that use a folder on this computer stay here."
      >
        <Toggle
          label="Sync with the web"
          checked={preference(settings, "cloudSync")}
          onChange={(cloudSync) => save({ cloudSync })}
        />
      </Row>
      <Row
        label="Control from your phone"
        description="While Claudex is open here, your phone can open, continue and stop the Code sessions on this computer and answer their approvals."
      >
        <Toggle
          label="Control from your phone"
          checked={preference(settings, "remoteControl")}
          onChange={(remoteControl) => save({ remoteControl })}
        />
      </Row>
      {preference(settings, "remoteControl") && (
        <RemoteFoldersRow settings={settings} save={save} onError={onError} />
      )}
    </Section>
  );
}

const speechListeners = (listener: () => void) => {
  addEventListener("claudex-speech-preferences", listener);
  return () => removeEventListener("claudex-speech-preferences", listener);
};
let cachedPreferences = "";
let cachedValue = speechPreferences();
function currentSpeechPreferences() {
  const next = JSON.stringify(speechPreferences());
  if (next !== cachedPreferences) {
    cachedPreferences = next;
    cachedValue = speechPreferences();
  }
  return cachedValue;
}

/**
 * Voice's Speed choices: Slow 0.8, Normal 1 and Fast 1.2. A rate kept from
 * before (1.5) shows as the nearest.
 */
export const speedChoices = [
  { rate: 0.8, label: "Slow" },
  { rate: 1, label: "Normal" },
  { rate: 1.2, label: "Fast" },
] as const;
export function nearestSpeed(rate: number) {
  return speedChoices.reduce((best, choice) =>
    Math.abs(choice.rate - rate) < Math.abs(best.rate - rate) ? choice : best,
  ).rate;
}

/** Voice (Language, Style, Speed): how a spoken reply sounds. */
export function VoiceSection() {
  const prefs = useSyncExternalStore(
    speechListeners,
    currentSpeechPreferences,
    currentSpeechPreferences,
  );
  const browserChosen = useSyncExternalStore(
    speechListeners,
    browserRecognitionChosen,
    () => false,
  );
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    let live = true;
    void loadVoices().then((list) => live && setVoices(list));
    return () => {
      live = false;
    };
  }, []);
  // Resting on a voice's mark plays a sample of it (voice-preview.tsx).
  const voicePreview = useVoicePreview();
  const [hovered, setHovered] = useState<string | null>(null);
  useHoverPreview(hovered, voicePreview);
  const base = prefs.language.slice(0, 2).toLowerCase();
  const shown = voices
    .filter((voice) => !base || voice.lang.slice(0, 2).toLowerCase() === base)
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Section
      title="Voice"
      note="Voice playback uses voices provided by your browser or operating system."
      tightNote
    >
      <SettingsVoice
        browserChosen={browserChosen}
        prefs={prefs}
        setHovered={setHovered}
        shown={shown}
        voicePreview={voicePreview}
      />
    </Section>
  );
}

/** What a notification switch's failed save says. */
const saveFailure = "Couldn’t save your change. Try again.";

/**
 * A notification switch: it moves at once and stays disabled until the change
 * is saved; a failed save puts it back with the error toast (SettingsDialog's
 * save).
 */
/** Keep permission follow-ups on the bridge and owner that started them. */
function notificationPermission(request: SettingsRequestScope) {
  const bridge = request.bridge!;
  return enableDesktopNotifications({
    getNotificationAuthorizationStatus: () =>
      bridge.getNotificationAuthorizationStatus(),
    requestNotificationAuthorization: () =>
      request.current()
        ? bridge.requestNotificationAuthorization()
        : Promise.resolve("denied" as const),
    openNotificationSettings: () =>
      request.current() ? bridge.openNotificationSettings() : Promise.resolve(),
  });
}

type SavingToggleProps = {
  label: string;
  checked: boolean;
  onChange: (checked: boolean, scope: SettingsRequestScope) => unknown;
};
function SavingToggle(props: SavingToggleProps) {
  const scope = useSettingsRequestScope();
  return <ScopedSavingToggle key={scope.key} {...props} scope={scope} />;
}
function ScopedSavingToggle({
  label,
  checked,
  onChange,
  scope,
}: SavingToggleProps & { scope: SettingsScopeOwner }) {
  const [pending, setPending] = useState(false);
  return (
    <Toggle
      label={label}
      checked={checked}
      disabled={pending}
      onChange={(next) => {
        const request = scope.capture();
        if (pending || !request.current()) return;
        setPending(true);
        void Promise.resolve()
          .then(() => (request.current() ? onChange(next, request) : undefined))
          .catch(() => {
            if (request.current()) showToast(t(saveFailure));
          })
          .finally(() => {
            if (request.current()) setPending(false);
          });
      }}
    />
  );
}

/** Notifications: sent while Claudex is in the background. */
export function NotificationsSection({
  settings,
  save,
}: {
  settings: Settings;
  save: TabProps["save"];
}) {
  const scope = useSettingsRequestScope();
  return (
    <ScopedNotificationsSection
      key={scope.key}
      settings={settings}
      save={save}
      scope={scope}
    />
  );
}

function ScopedNotificationsSection({
  settings,
  save,
  scope,
}: {
  settings: Settings;
  save: TabProps["save"];
  scope: SettingsScopeOwner;
}) {
  const host = useHost();
  const codeNotifications =
    (host.capabilities.localCode || host.capabilities.cloudCode) &&
    (host.kind === "desktop" || notificationsAvailable());
  // The scheduled-task e-mail row shows where the service can send it.
  const [routineEmail, setRoutineEmail] = useState(false);
  const [codeEmail, setCodeEmail] = useState<
    "loading" | "available" | "unavailable" | "error"
  >("loading");
  const [emailRetry, setEmailRetry] = useState(0);
  const canCheckCodeEmail =
    host.capabilities.cloudCode && !!scope.capture().bridge?.codeEmailStatus;
  useEffect(() => {
    const request = scope.capture();
    let active = true;
    void request.bridge
      ?.routineCapabilities?.()
      .then((value) => {
        if (active && request.current()) setRoutineEmail(Boolean(value?.email));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [scope.key]);
  useEffect(() => {
    const request = scope.capture();
    let active = true;
    if (!canCheckCodeEmail) {
      setCodeEmail("unavailable");
      return;
    }
    setCodeEmail("loading");
    void request
      .bridge!.codeEmailStatus()
      .then((status) => {
        if (active && request.current())
          setCodeEmail(status.available ? "available" : "unavailable");
      })
      .catch(() => {
        if (active && request.current()) setCodeEmail("error");
      });
    return () => {
      active = false;
    };
  }, [scope.key, canCheckCodeEmail, emailRetry]);
  return (
    <Section title="Notifications">
      <Row
        label="Response completions"
        description="Get notified when Claudex has finished a response. Useful for long-running tasks."
      >
        <SavingToggle
          label="Response completions"
          checked={preference(settings, "notifyResponses")}
          onChange={async (notifyResponses, request) => {
            // On the web the browser shows them: turning the switch on asks for
            // its permission first, and a refusal keeps it off with the
            // original's explanation. The switch is Chat's alone now: the
            // desktop's Code and Cowork banners follow the notification levels,
            // which saving it stores as they stand
            // (shared/notification-levels.ts).
            const patch = { notifyResponses, ...freezeLevels(settings) };
            if (surface === "desktop" && notifyResponses) {
              try {
                const allowed = await notificationPermission(request);
                if (!request.current() || !allowed) return;
              } catch {
                if (request.current()) showToast(t(saveFailure));
                return;
              }
            }
            if (surface === "web" && notifyResponses) {
              const refusal = permissionRefusal(
                await askNotificationPermission(),
              );
              if (!request.current()) return;
              if (refusal) return showToast(t(refusal));
            }
            if (request.current()) await save(patch, saveFailure);
          }}
        />
      </Row>
      <Row
        label="Scheduled tasks"
        description="Get notified when scheduled tasks finish, can’t run, or need your input."
      >
        <SavingToggle
          label="Scheduled tasks"
          checked={preference(settings, "notifySchedules")}
          onChange={async (notifySchedules, request) => {
            if (surface === "desktop" && notifySchedules) {
              try {
                const allowed = await notificationPermission(request);
                if (!request.current() || !allowed) return;
              } catch {
                if (request.current()) showToast(t(saveFailure));
                return;
              }
            }
            // On the web the browser shows them: a refusal keeps the switch off.
            if (surface === "web" && notifySchedules) {
              const refusal = permissionRefusal(
                await askNotificationPermission(),
              );
              if (!request.current()) return;
              if (refusal) return showToast(t(refusal));
            }
            if (request.current()) await save({ notifySchedules }, saveFailure);
          }}
        />
      </Row>
      {/* routines.enable_email; mailed through the service, to this account. */}
      {routineEmail && (
        <Row
          label="Scheduled tasks by email"
          description="Get an email when scheduled tasks finish or can’t run. A task can also ask for one in its own settings."
        >
          <SavingToggle
            label="Scheduled tasks by email"
            checked={preference(settings, "notifySchedulesEmail")}
            onChange={(notifySchedulesEmail) =>
              save({ notifySchedulesEmail }, saveFailure)
            }
          />
        </Row>
      )}
      {codeNotifications && (
        <Row
          label="Code notifications"
          description="Claudex can choose to notify you about important updates from a Code session."
        >
          <SavingToggle
            label="Code notifications"
            checked={preference(settings, "notifyCodeUpdates")}
            onChange={async (notifyCodeUpdates, request) => {
              if (surface === "desktop" && notifyCodeUpdates) {
                try {
                  const allowed = await notificationPermission(request);
                  if (!request.current() || !allowed) return;
                } catch {
                  if (request.current()) showToast(t(saveFailure));
                  return;
                }
              }
              // On the web the browser shows them: a refusal keeps it off.
              if (surface === "web" && notifyCodeUpdates) {
                const refusal = permissionRefusal(
                  await askNotificationPermission(),
                );
                if (!request.current()) return;
                if (refusal) return showToast(t(refusal));
              }
              if (request.current())
                await save({ notifyCodeUpdates }, saveFailure);
            }}
          />
        </Row>
      )}
      {codeNotifications && (
        <Row
          label="Code permission requests"
          description="Get a push notification when Claudex needs your approval to run a command in a Code session."
        >
          <SavingToggle
            label="Code permission requests"
            checked={preference(settings, "notifyCodePermissions")}
            onChange={async (notifyCodePermissions, request) => {
              if (notifyCodePermissions) {
                if (surface === "desktop") {
                  const allowed = await notificationPermission(request);
                  if (!request.current()) return;
                  if (!allowed) {
                    showToast(
                      t(
                        "Notifications are blocked. Allow them in system settings, then try again.",
                      ),
                    );
                    return;
                  }
                } else {
                  const refusal = permissionRefusal(
                    await askNotificationPermission(),
                  );
                  if (!request.current()) return;
                  if (refusal) {
                    showToast(t(refusal));
                    return;
                  }
                }
              }
              if (request.current())
                await save({ notifyCodePermissions }, saveFailure);
            }}
          />
        </Row>
      )}
      {canCheckCodeEmail && codeEmail === "loading" && (
        <Row label="Emails from Claudex Code cloud sessions">
          <span role="status">{t("Loading…")}</span>
        </Row>
      )}
      {canCheckCodeEmail && codeEmail === "error" && (
        <Row
          label="Emails from Claudex Code cloud sessions"
          description="Couldn’t load email notification availability."
        >
          <button
            className="settings-button"
            onClick={() => setEmailRetry((value) => value + 1)}
          >
            {t("Retry")}
          </button>
        </Row>
      )}
      {canCheckCodeEmail && codeEmail === "available" && (
        <Row
          label="Emails from Claudex Code cloud sessions"
          description="Get an email when a cloud session has finished building or needs your response."
        >
          <SavingToggle
            label="Emails from Claudex Code cloud sessions"
            checked={preference(settings, "notifyCodeEmail")}
            onChange={async (notifyCodeEmail, request) => {
              // Recheck at enable time: the service's mail configuration or
              // the account's address may have changed since this page loaded.
              if (notifyCodeEmail) {
                const status = await request.bridge!.codeEmailStatus();
                if (!request.current()) return;
                if (!status.available) {
                  setCodeEmail("unavailable");
                  showToast(
                    t("Email notifications are unavailable for this account."),
                  );
                  return;
                }
              }
              if (request.current())
                await save({ notifyCodeEmail }, saveFailure);
            }}
          />
        </Row>
      )}
      <ArtifactMailRows scope={scope} />
    </Section>
  );
}

/**
 * The e-mails about shared artifacts: Mentions and replies, Comments on your
 * artifacts and Artifacts shared with you. The service keeps them, so they show
 * where the account has hosted sharing.
 */
function ArtifactMailRows({ scope }: { scope: SettingsScopeOwner }) {
  const [prefs, setPrefs] = useState<ArtifactMailPreferences | null>(null);
  useEffect(() => {
    const request = scope.capture();
    let active = true;
    void request.bridge
      ?.artifactMailPreferences?.()
      .then((value) => {
        if (active && request.current()) setPrefs(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [scope.key]);
  if (!prefs) return null;
  const row = (
    key: keyof ArtifactMailPreferences,
    label: string,
    description: string,
  ) => (
    <Row label={label} description={description}>
      <SavingToggle
        label={label}
        checked={prefs[key]}
        onChange={async (on, request) => {
          const next = await request.bridge!.setArtifactMailPreferences({
            [key]: on,
          });
          if (request.current()) setPrefs(next);
        }}
      />
    </Row>
  );
  return (
    <>
      {row(
        "mentions",
        "Mentions and replies",
        "Get an email when someone @mentions you on an artifact, or replies in a comment thread you’re part of.",
      )}
      {row(
        "comments",
        "Comments on your artifacts",
        "Get an email when someone comments on an artifact you own, even when you’re not mentioned. Follows “Mentions and replies” until you change it.",
      )}
      {row(
        "shares",
        "Artifacts shared with you",
        "Get an email when someone shares an artifact with you.",
      )}
    </>
  );
}
