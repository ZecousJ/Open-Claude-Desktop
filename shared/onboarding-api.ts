/**
 * The first-run onboarding: a new account answers a few questions once, after
 * sign-up. The service keeps whether it is still to do and the answers (backend
 * internal/claudex/onboarding): the sign-up writes it as pending, each answer
 * is saved as it is given, and the last step finishes it, after which no device
 * shows it again. Accounts made before it are never asked.
 */
import { bridgeMethods } from "./bridge-methods";
import { normalizeWorkType, type WorkType } from "./settings-extras";

/**
 * "How did you get here?". The original shuffles the list for each person and
 * keeps Other last.
 */
export const hearAboutSources = [
  { value: "word_of_mouth", label: "Friend or family" },
  { value: "work_employer", label: "Work or employer" },
  { value: "social_media", label: "Social media" },
  { value: "news_article", label: "News" },
  { value: "search_engine", label: "Google/search engine" },
  { value: "online_ad", label: "Ad online" },
  { value: "tv", label: "TV" },
  { value: "podcast", label: "Podcast" },
  { value: "professional_event", label: "Event" },
  { value: "influencer", label: "Influencer" },
  { value: "other", label: "Other" },
] as const;
export type HearAboutSource = (typeof hearAboutSources)[number]["value"];

/** "Which one?" after Social media. */
export const hearAboutPlatforms = [
  { value: "x_twitter", label: "X / Twitter" },
  { value: "reddit", label: "Reddit" },
  { value: "youtube", label: "YouTube" },
  { value: "tiktok", label: "TikTok" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "instagram", label: "Instagram" },
  { value: "other", label: "Other" },
] as const;
export type HearAboutPlatform = (typeof hearAboutPlatforms)[number]["value"];

/** What "Set up and start coding" led to. */
export type CodeSetup = "desktop" | "web" | "skipped";

/** The answers; a missing field was not answered (or is not being changed). */
export interface OnboardingAnswers {
  workFunction?: WorkType;
  hearAbout?: HearAboutSource;
  hearAboutPlatform?: HearAboutPlatform;
  /** The "Other" text (or the platform's). */
  hearAboutOther?: string;
  codeSetup?: CodeSetup;
  /** Connectors connected during "Connect your work tools". */
  connectedTools?: string[];
  /** The starter task picked first, "own_topic", or "skipped". */
  firstTask?: string;
  /** "What kind of science do you do?" under the Scientist role. */
  scienceFields?: ScienceField[];
}

/** The fields of "What kind of science do you do? (optional)", in its order. */
export const scienceFields = [
  { value: "biology", label: "Biology" },
  { value: "chemistry", label: "Chemistry" },
  { value: "clinical_medical", label: "Clinical / medical" },
  { value: "computer_science_ml", label: "Computer science / ML" },
  { value: "engineering", label: "Engineering" },
  { value: "materials_science", label: "Materials science" },
  { value: "mathematics", label: "Mathematics" },
  { value: "physics", label: "Physics" },
  { value: "social_sciences", label: "Social sciences" },
  { value: "other", label: "Other" },
] as const;
export type ScienceField = (typeof scienceFields)[number]["value"];

export interface OnboardingState {
  /** The account signed up and has not finished: the window shows it. */
  pending: boolean;
  answers: OnboardingAnswers;
}

export interface OnboardingAPI {
  /** Whether this account still has the onboarding to do, and its answers. */
  onboardingState(): Promise<OnboardingState>;
  /**
   * Saves the answers given (only those fields change); `finished` ends the
   * onboarding for good. The work type is also saved here when it changes in
   * Settings, so the service keeps the current one.
   */
  saveOnboarding(
    answers: OnboardingAnswers,
    finished?: boolean,
  ): Promise<OnboardingState>;
}

export const onboardingMethods = bridgeMethods<OnboardingAPI>({
  onboardingState: true,
  saveOnboarding: true,
});

/** Nothing to do: no service, or an account made before the onboarding. */
export const noOnboarding: OnboardingState = { pending: false, answers: {} };

const oneOf = <T extends string>(
  value: unknown,
  list: readonly { value: T }[],
): T | undefined =>
  list.find((entry) => entry.value === value)?.value ?? undefined;

const text = (value: unknown, limit: number) =>
  typeof value === "string" ? value.slice(0, limit) : "";

/** The service's answer (`data`) as the window uses it. */
export function onboardingFrom(data: unknown): OnboardingState {
  if (!data || typeof data !== "object") return noOnboarding;
  const body = data as Record<string, unknown>;
  const raw = (
    body.answers && typeof body.answers === "object" ? body.answers : {}
  ) as Record<string, unknown>;
  const answers: OnboardingAnswers = {};
  const work = normalizeWorkType(raw.work_function);
  if (work) answers.workFunction = work;
  const hear = oneOf(raw.hear_about, hearAboutSources);
  if (hear) answers.hearAbout = hear;
  const platform = oneOf(raw.hear_about_platform, hearAboutPlatforms);
  if (platform) answers.hearAboutPlatform = platform;
  const other = text(raw.hear_about_other, 200);
  if (other) answers.hearAboutOther = other;
  if (
    raw.code_setup === "desktop" ||
    raw.code_setup === "web" ||
    raw.code_setup === "skipped"
  )
    answers.codeSetup = raw.code_setup;
  if (Array.isArray(raw.connected_tools))
    answers.connectedTools = raw.connected_tools
      .filter((name): name is string => typeof name === "string")
      .slice(0, 20);
  if (Array.isArray(raw.science_fields))
    answers.scienceFields = scienceFields
      .map((field) => field.value)
      .filter((value) => (raw.science_fields as unknown[]).includes(value));
  const task = text(raw.first_task, 60);
  if (task) answers.firstTask = task;
  return { pending: body.pending === true, answers };
}

/** The PUT body for the service: only the fields given. */
export function onboardingBody(
  answers: OnboardingAnswers,
  finished = false,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (answers.workFunction !== undefined)
    body.work_function = answers.workFunction;
  if (answers.hearAbout !== undefined) {
    body.hear_about = answers.hearAbout;
    body.hear_about_platform = answers.hearAboutPlatform ?? "";
    body.hear_about_other = (answers.hearAboutOther ?? "").slice(0, 200);
  }
  if (answers.codeSetup !== undefined) body.code_setup = answers.codeSetup;
  if (answers.connectedTools !== undefined)
    body.connected_tools = answers.connectedTools.slice(0, 20);
  if (answers.firstTask !== undefined) body.first_task = answers.firstTask;
  if (answers.scienceFields !== undefined)
    body.science_fields = answers.scienceFields;
  if (finished) body.finished = true;
  return body;
}
