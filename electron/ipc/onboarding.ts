import { z } from "zod";
import {
  hearAboutPlatforms,
  hearAboutSources,
  noOnboarding,
  onboardingBody,
  onboardingFrom,
  onboardingMethods,
  scienceFields,
  type OnboardingAnswers,
  type OnboardingState,
} from "../../shared/onboarding-api";
import { workTypes } from "../../shared/settings-extras";
import type { AppContext, IpcHandle } from "../app/app-context";
import { requestJson } from "../sub2api/http";

const values = <T extends string>(list: readonly { value: T }[]) =>
  list.map((entry) => entry.value) as [T, ...T[]];

/** What the window may send; the service checks it again. */
const answersSchema = z
  .object({
    workFunction: z.enum(values(workTypes)).optional(),
    hearAbout: z.enum(values(hearAboutSources)).optional(),
    hearAboutPlatform: z.enum(values(hearAboutPlatforms)).optional(),
    hearAboutOther: z.string().max(200).optional(),
    codeSetup: z.enum(["desktop", "web", "skipped"]).optional(),
    connectedTools: z.array(z.string().max(100)).max(20).optional(),
    firstTask: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .max(60)
      .optional(),
    scienceFields: z
      .array(z.enum(values(scienceFields)))
      .max(10)
      .optional(),
  })
  .strict();

/**
 * The first-run onboarding of a signed-in Claudex account: whether it is
 * still to do, and its answers, read and written with the session's token in
 * the main process. Without the service (or with one that has no onboarding,
 * 404) there is nothing to show.
 */
export function registerOnboardingHandlers(handle: IpcHandle, ctx: AppContext) {
  const service = () => (ctx.remote?.ready ? ctx.remote.backend : undefined);
  const url = () =>
    `${ctx.remote!.backend.accounts.baseUrl}/api/v1/claudex/onboarding`;
  handle("onboardingState", async (): Promise<OnboardingState> => {
    const backend = service();
    if (!backend) return noOnboarding;
    try {
      return onboardingFrom(
        await backend.session.authorized((token) =>
          requestJson(fetch, url(), { token }),
        ),
      );
    } catch {
      // A service that can't answer shows nothing; the next start asks again.
      return noOnboarding;
    }
  });
  handle(
    "saveOnboarding",
    async (rawAnswers: unknown, rawFinished: unknown) => {
      const answers: OnboardingAnswers = answersSchema.parse(rawAnswers);
      const finished = z.boolean().optional().parse(rawFinished) ?? false;
      const backend = service();
      if (!backend) return noOnboarding;
      return onboardingFrom(
        await backend.session.authorized((token) =>
          requestJson(fetch, url(), {
            method: "PUT",
            body: onboardingBody(answers, finished),
            token,
          }),
        ),
      );
    },
  );
  // Keeps this list and the bridge's in step.
  void onboardingMethods;
}
