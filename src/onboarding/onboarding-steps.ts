/**
 * The order of the first-run onboarding: "What kind of work do you do?"; for a
 * coding role "Set up and start coding" (`connector_claude_code`, roles `fs`);
 * "Connect your work tools" (`connector_connect`); "How did you get here?"
 * (`hear_about`); then the first task. There is no Back: each step goes
 * forward, and every step after the role can be skipped. The step reached is
 * kept in this browser, so a window closed half-way opens on it again (the
 * original keeps it in local storage too).
 */
import type { WorkType } from "../../shared/settings-extras";

export type OnboardingStep =
  "work" | "code" | "connect" | "hear" | "quick-entry" | "first";

export const onboardingSteps: readonly OnboardingStep[] = [
  "work",
  "code",
  "connect",
  "hear",
  "quick-entry",
  "first",
];

/** The roles offered "Set up and start coding". */
export const codingRoles: readonly WorkType[] = [
  "Engineering",
  "SoftwareEngineer",
  "Data Science",
  "Founder",
  "Product Management",
];

/** Whether a step is shown for this work type. */
export function stepShown(
  step: OnboardingStep,
  workType?: WorkType,
  desktop = false,
) {
  if (step === "quick-entry") return desktop;
  return step !== "code" || (!!workType && codingRoles.includes(workType));
}

/** The step after `step`, or undefined at the end. */
export function nextStep(
  step: OnboardingStep,
  workType?: WorkType,
  desktop = false,
): OnboardingStep | undefined {
  const at = onboardingSteps.indexOf(step);
  return onboardingSteps
    .slice(at + 1)
    .find((candidate) => stepShown(candidate, workType, desktop));
}

const storageKey = (accountId: string) =>
  `claudex.onboarding.step.${accountId}`;

/** The step this browser reached for the account, or the first. */
export function savedStep(
  accountId: string,
  workType?: WorkType,
  desktop = false,
) {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(storageKey(accountId));
  } catch {
    // Storage can be off; the onboarding starts at the beginning.
  }
  const step = onboardingSteps.find((s) => s === saved);
  // A later step needs the role; without it the person starts over.
  if (!step || !workType || !stepShown(step, workType, desktop)) return "work";
  return step;
}

export function saveStep(accountId: string, step: OnboardingStep | undefined) {
  try {
    if (step) localStorage.setItem(storageKey(accountId), step);
    else localStorage.removeItem(storageKey(accountId));
  } catch {
    // Not kept: a reload starts at the first step again.
  }
}

/**
 * "How did you get here?" in the original's order: shuffled for each person,
 * Other last.
 */
export function shuffledWithOtherLast<T extends { value: string }>(
  list: readonly T[],
  random: () => number = Math.random,
): T[] {
  const rest = list.filter((entry) => entry.value !== "other");
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  const other = list.find((entry) => entry.value === "other");
  return other ? [...rest, other] : rest;
}
