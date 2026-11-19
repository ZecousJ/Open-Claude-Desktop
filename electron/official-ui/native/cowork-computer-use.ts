import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ComputerUseAPI } from "../../../shared/computer-use-api";
import type {
  ComputerUseAccessRequest,
  ComputerUseState,
} from "../../../shared/computer-use";

export const coworkComputerUsePrefix = "cowork-computer-use:";

export function coworkComputerUseCard(
  request: ComputerUseAccessRequest,
  state: ComputerUseState,
) {
  const id = coworkComputerUsePrefix + request.id;
  const apps =
    request.kind === "apps"
      ? request.apps.map(({ app, tier }) => ({
          requestedName: app.name,
          resolved: { bundleId: app.id, displayName: app.name, path: "" },
          alreadyGranted: false,
          proposedTier: tier,
        }))
      : [];
  return {
    requestId: id,
    sessionId: `local_${request.conversationId}`,
    toolName: "computer:request_access",
    requiresUserInteraction: true,
    input: {
      requestId: id,
      reason: request.reason ?? "",
      apps,
      requestedFlags: request.clipboard
        ? {
            clipboardRead: request.clipboard.read,
            clipboardWrite: request.clipboard.write,
          }
        : {},
      hostPlatform: process.platform,
      screenshotFiltering: process.platform === "darwin" ? "native" : "none",
      preferredModeDefault:
        state.settings.mode === "fullControl" ? "full_control" : "background",
      ...(request.kind === "full-control"
        ? {
            takeoverFrom: {
              displayNames: request.apps.map(({ app }) => app.name),
              becausePreferredBackground: true,
            },
          }
        : {}),
      ...(request.kind === "permissions"
        ? {
            tccState: {
              accessibility:
                state.permissions?.accessibility ?? "not-determined",
              screenRecording: state.permissions?.screen ?? "not-determined",
            },
          }
        : {}),
    },
  };
}

const consent = z.object({
  _cuGrants: z.strictObject({
    granted: z
      .array(
        z.strictObject({
          bundleId: z.string(),
          displayName: z.string(),
          grantedAt: z.number().finite(),
          tier: z.enum(["read", "click", "full"]),
        }),
      )
      .max(10),
    denied: z.tuple([]),
    flags: z.strictObject({
      clipboardRead: z.boolean(),
      clipboardWrite: z.boolean(),
      systemKeyCombos: z.literal(false),
    }),
    userConsented: z.literal(true),
  }),
});

export function coworkComputerUseDecision(
  request: ComputerUseAccessRequest,
  decision: string,
  input: unknown,
): Parameters<ComputerUseAPI["answerComputerUseAccess"]>[1] {
  if (decision === "deny") return "deny";
  const parsed = consent.safeParse(input);
  if (
    decision !== "always" ||
    request.kind === "permissions" ||
    !parsed.success
  )
    throw Error("Confirm the displayed computer-use request.");
  const { granted, flags } = parsed.data._cuGrants;
  const apps = request.kind === "apps" ? request.apps : [];
  const expected = apps.map(({ app, tier }) => ({
    bundleId: app.id,
    displayName: app.name,
    tier,
  }));
  if (
    !isDeepStrictEqual(
      granted.map(({ grantedAt, ...app }) => app),
      expected,
    ) ||
    flags.clipboardRead !== (request.clipboard?.read ?? false) ||
    flags.clipboardWrite !== (request.clipboard?.write ?? false)
  )
    throw Error(
      "The computer-use decision does not match the displayed request.",
    );
  return { allow: apps.map(({ app }) => app.id), deny: [] };
}
