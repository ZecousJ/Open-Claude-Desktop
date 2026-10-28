import {
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { lazyPiece } from "../ui/lazy-piece";
import { api } from "../desktop-api";
import { t } from "../i18n";
import { Star } from "../ui/Star";
import { WindowControls } from "../app/WindowControls";
import { useHost } from "../host/HostContext";
import {
  type CodeSetup,
  type OnboardingAnswers,
  type OnboardingState,
  type ScienceField,
} from "../../shared/onboarding-api";
import { type WorkType } from "../../shared/settings-extras";
import {
  nextStep,
  saveStep,
  savedStep,
  type OnboardingStep,
} from "./onboarding-steps";
import { firstTasksFor } from "./first-tasks";
import "./onboarding.css";
import { WorkStep, CodeStep, FirstTaskStep } from "./OnboardingSteps";
import { ConnectStep, HearStep } from "./OnboardingConnect";
const QuickEntryOnboarding = lazyPiece(() => import("./QuickEntryOnboarding"));

/** Where the onboarding leaves the person. */
export interface OnboardingExit {
  /** Code when "Set up and start coding" chose a place to code. */
  mode: "home" | "code";
  /** A starter task's prompt for the composer. */
  prompt?: string;
}

const mac =
  typeof navigator !== "undefined" &&
  /Mac/i.test(navigator.platform || navigator.userAgent);

/**
 * The first-run onboarding, shown once to a new account after sign-up (and
 * after the profile step, which hands over to it): a full window of its own,
 * one question at a time. Every answer is saved on the service as it is given;
 * the last step finishes it there, so no device shows it again.
 */
export default function OnboardingFlow({
  accountId,
  initial,
  workType: settingsWorkType,
  onWorkType,
  onOpenConnectors,
  onOpenSystem,
  platform,
  onFinish,
}: {
  accountId: string;
  initial: OnboardingState;
  /** The Settings work type, the role step's starting value. */
  workType?: WorkType;
  /** Saves the work type in Settings too (one value, as the original). */
  onWorkType: (workType: WorkType) => void;
  /** Settings ▸ Connectors, over the onboarding. */
  onOpenConnectors: () => void;
  onOpenSystem: () => void;
  platform: string;
  onFinish: (exit: OnboardingExit) => void;
}) {
  const desktop = useHost().capabilities.systemIntegration;
  const startWork = initial.answers.workFunction ?? settingsWorkType;
  const [workType, setWorkType] = useState<WorkType | undefined>(startWork);
  const [science, setScience] = useState<ScienceField[]>(
    initial.answers.scienceFields ?? [],
  );
  const [step, setStep] = useState<OnboardingStep>(() =>
    savedStep(accountId, initial.answers.workFunction, desktop),
  );
  const [codeSetup, setCodeSetup] = useState<CodeSetup | undefined>(
    initial.answers.codeSetup,
  );
  const [finishing, setFinishing] = useState(false);
  const main = useRef<HTMLElement>(null);

  // A new step starts at the top, with the keyboard on its heading.
  useEffect(() => {
    saveStep(accountId, step);
    main.current?.scrollTo?.({ top: 0 });
    main.current
      ?.querySelector<HTMLElement>("h1")
      ?.focus({ preventScroll: true });
  }, [step, accountId]);

  /** Saves answers; a failure is retried with the next one (or finish). */
  const pending = useRef<OnboardingAnswers>({});
  const save = (answers: OnboardingAnswers) => {
    const merged = { ...pending.current, ...answers };
    pending.current = {};
    void Promise.resolve()
      .then(() => api.saveOnboarding(merged))
      .catch(() => {
        pending.current = { ...merged, ...pending.current };
      });
  };
  const advance = (role = workType) => {
    const next = nextStep(step, role, desktop);
    if (next) setStep(next);
  };
  const finish = (answers: OnboardingAnswers, exit: OnboardingExit) => {
    if (finishing) return;
    setFinishing(true);
    const merged = { ...pending.current, ...answers };
    void Promise.resolve()
      .then(() => api.saveOnboarding(merged, true))
      .catch(() => {})
      .finally(() => {
        // Finished here even when the service could not hear it: the next
        // start asks the service again.
        saveStep(accountId, undefined);
        onFinish(exit);
      });
  };

  let content: ReactNode;
  if (step === "work")
    content = (
      <WorkStep
        value={workType}
        onChange={setWorkType}
        science={science}
        onScienceChange={setScience}
        onContinue={(role) => {
          onWorkType(role);
          save({
            workFunction: role,
            scienceFields: role === "Scientist" ? science : [],
          });
          advance(role);
        }}
      />
    );
  else if (step === "code")
    content = (
      <CodeStep
        onPick={(place) => {
          setCodeSetup(place);
          save({ codeSetup: place });
          advance();
        }}
        onSkip={() => {
          setCodeSetup("skipped");
          save({ codeSetup: "skipped" });
          advance();
        }}
      />
    );
  else if (step === "connect")
    content = (
      <ConnectStep
        onOpenConnectors={onOpenConnectors}
        onContinue={(connected) => {
          save({ connectedTools: connected });
          advance();
        }}
      />
    );
  else if (step === "hear")
    content = (
      <HearStep
        onContinue={(answer) => {
          if (answer) save(answer);
          advance();
        }}
      />
    );
  else if (step === "quick-entry")
    content = (
      <Suspense fallback={null}>
        <QuickEntryOnboarding
          platform={platform}
          onSettings={onOpenSystem}
          onContinue={() => advance()}
        />
      </Suspense>
    );
  else {
    const mode =
      codeSetup === "desktop" || codeSetup === "web" ? "code" : "home";
    content = (
      <FirstTaskStep
        tasks={firstTasksFor(workType)}
        busy={finishing}
        onPick={(task) =>
          finish({ firstTask: task.id }, { mode, prompt: t(task.prompt) })
        }
        onOwnTopic={() => finish({ firstTask: "own_topic" }, { mode })}
      />
    );
  }
  return <OnboardingFrame main={main}>{content}</OnboardingFrame>;
}

/**
 * The page every step sits in: the window's drag strip on the desktop, the
 * wordmark centred 40px from the top, then the step centred in the rest of the
 * window.
 */
function OnboardingFrame({
  main,
  children,
}: {
  main: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const web = useHost().kind === "web";
  return (
    <div
      className="onboarding"
      role="dialog"
      aria-modal="true"
      aria-label={t("Welcome to Claudex")}
    >
      {!web && (
        <div className="onboarding-drag">{!mac && <WindowControls />}</div>
      )}
      <div className="onboarding-brand" aria-hidden="true">
        <Star size={22} />
        <span>Claudex</span>
      </div>
      <main ref={main} className="onboarding-main">
        {children}
      </main>
    </div>
  );
}
