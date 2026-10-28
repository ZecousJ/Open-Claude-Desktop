import { Suspense, useEffect, useState, type ReactNode } from "react";
import { Info, X } from "../ui/glyphs";
import type { Mode } from "../../shared/types";
import { IconButton, Modal } from "../ui/Controls";
import { Star } from "../ui/Star";
import { homeGreeting, timeOfDayGreeting } from "../../shared/home-greeting";
import { surface } from "../../shared/host";
import {
  firstHomeGreeting,
  firstHomeViewShown,
  writeBootHints,
} from "../boot/boot-hints";
import { useLocale, useT } from "../i18n";
import { setPromptPreview } from "../composer/prompt-preview";
import { lazyPiece } from "../ui/lazy-piece";
import { useVoiceSurface } from "../voice/voice-surface";

// The prompt ideas under the Chat composer load, with their styles, only
// when the home shows them (the web app's first-load budget is tight).
const StarterPrompts = lazyPiece(
  () => import("../starter-prompts/HomeStarters"),
  "default",
  { silent: true },
);

const web = surface === "web";

/** A home greeting as shown: "Good morning, Ann" holds {name} in the catalogs. */
function greetingLine(
  t: (text: string) => string,
  name: string,
  hour: number,
  roll: number,
) {
  const said = homeGreeting(name, hour, roll);
  const named =
    /^(Good morning|Good afternoon|Good evening|Afternoon|Back at it), (.+)$/.exec(
      said,
    );
  return named
    ? t(`${named[1]}, {name}`).replace("{name}", named[2]!)
    : t(said);
}

export function ChatHome({
  name,
  model,
  connectionDismissed,
  onServiceStatus,
  onDismiss,
  onSuggestion,
  composer,
  incognito = false,
  conversationCount = 0,
  accountEmail,
}: {
  conversationCount?: number;
  accountEmail?: string;
  incognito?: boolean;
  /** The web Cowork home's Active list, shown where there are no folder ideas. */
  activeList?: ReactNode;
  name: string;
  mode: Mode;
  model: string;
  connectionDismissed: boolean;
  /** Opens the Service status page. */
  onServiceStatus: () => void;
  onDismiss: () => void;
  onSuggestion: (prompt: string, submit?: boolean) => void;
  composer: ReactNode;
}) {
  // Chosen once per home view so switching between Chat and Cowork keeps the
  // same greeting; the web app's first view uses the cached choice
  // (src/boot/boot-hints.ts).
  const [greeting] = useState(() => {
    const hour = new Date().getHours();
    const painted = web ? firstHomeGreeting(hour, location.search) : undefined;
    return { hour, roll: painted?.roll ?? Math.random() };
  });
  const t = useT();
  const locale = useLocale();
  const voiceActive = useVoiceSurface();
  const [incognitoHelp, setIncognitoHelp] = useState(false);
  useEffect(() => {
    if (!incognito) setIncognitoHelp(false);
  }, [incognito]);
  const greetingText = greetingLine(t, name, greeting.hour, greeting.roll);
  // Cache a fresh choice for the next home view after a page load.
  useEffect(() => {
    if (!web) return;
    firstHomeViewShown();
    const roll = Math.random();
    writeBootHints({
      greeting: {
        slot: timeOfDayGreeting(greeting.hour),
        roll,
        text: greetingLine(t, name, greeting.hour, roll),
      },
    });
  }, [name, locale]);
  // A greeting that changes while the home is open (incognito on or off, a
  // new name) fades in over 350ms; the first one and a language change just
  // show (the original's greeting-fade-in).
  const shownGreeting = incognito ? t("You’re incognito") : greetingText;
  const [greetingShown, setGreetingShown] = useState({
    text: shownGreeting,
    locale,
    fades: 0,
  });
  if (greetingShown.text !== shownGreeting)
    setGreetingShown({
      text: shownGreeting,
      locale,
      fades:
        greetingShown.text && greetingShown.locale === locale
          ? greetingShown.fades + 1
          : greetingShown.fades,
    });
  // A suggestion's preview never outlives the home.
  useEffect(() => () => setPromptPreview(null), []);
  return (
    <div className="chat-home">
      <h1
        key={greetingShown.fades}
        className={greetingShown.fades > 0 ? "greeting-fade" : undefined}
      >
        <Star size={40} />
        {shownGreeting}
      </h1>
      {!model && !connectionDismissed && (
        <div className="connection-notice">
          <Info size={15} />
          <span>Model service unavailable</span>
          <button onClick={onServiceStatus}>Service status</button>
          <IconButton label="Dismiss" onClick={onDismiss}>
            <X size={15} />
          </IconButton>
        </div>
      )}
      {composer}
      {incognito && (
        <p className="incognito-note">
          {t("Incognito sessions stay out of your history and search.")}{" "}
          <button
            type="button"
            className="incognito-learn-more"
            onClick={() => setIncognitoHelp(true)}
          >
            {t("Learn more")}
          </button>
        </p>
      )}
      {incognito && incognitoHelp && (
        <Modal title={t("Incognito")} onClose={() => setIncognitoHelp(false)}>
          <p>{t("Incognito sessions stay out of your history and search.")}</p>
          <p>
            {t(
              "Your model service still receives your messages. Its data policies apply.",
            )}
          </p>
          <div className="button-row">
            <button type="button" onClick={() => setIncognitoHelp(false)}>
              {t("Close")}
            </button>
          </div>
        </Modal>
      )}
      {!incognito && !voiceActive && (
        <Suspense fallback={null}>
          <StarterPrompts
            homeShaped={web}
            targetKind="chat"
            onPick={onSuggestion}
            conversationCount={conversationCount}
            accountEmail={accountEmail}
          />
        </Suspense>
      )}
    </div>
  );
}
