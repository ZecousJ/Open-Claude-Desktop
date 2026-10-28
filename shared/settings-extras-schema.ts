/**
 * Validation of the Settings-page preferences, spread into the main process's
 * settings schema. A new preference is added to `SettingsPreferences` and
 * `preferenceDefaults` in `settings-extras.ts` and validated here;
 * `electron/main.ts` does not change. Kept apart from `settings-extras.ts` so
 * the window's bundle does not include zod.
 */
import { hasPrimaryModifier, validAccelerator } from "./accelerator";
import { envFileLimit } from "./env-file";
import { validBranchPrefix } from "./branch-prefix";
import { localeIds } from "./locales";
import { notificationLevelValues } from "./notification-levels";
import { z } from "zod";
import { capabilityTips } from "./chat-suggestions";
import { homeChecklistTasks } from "./home-starters";
import { remoteFolderValid, remoteFoldersLimit } from "./remote-devices";
import {
  allowedSiteValid,
  browserAllowedSitesLimit,
  browserKeepCookiesOptions,
  coworkInstructionsLimit,
  taskPermissions,
  type BrowserKeepCookies,
  normalizeWorkType,
  workTypes,
  type SettingsPreferences,
  type WorkType,
} from "./settings-extras";

export const preferenceFields = {
  extensionAutoUpdates: z.boolean().optional(),
  extensionBuiltInNode: z.boolean().optional(),
  avatar: z.number().int().min(0).max(72).optional(),
  avatarPhoto: z
    .string()
    .max(700_000)
    .regex(/^(?:|data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2})$/)
    .optional(),
  profilePhotoEnabled: z.boolean().optional(),
  computerAccess: z.boolean().optional(),
  homeStarters: z
    .object({
      chipsOverride: z.enum(["show", "hide"]).optional(),
      prosumer_checklist_hide_prompt_chips: z.boolean().optional(),
      prosumer_checklist_v2: z
        .partialRecord(z.enum(homeChecklistTasks), z.boolean())
        .optional(),
      checklist: z
        .object({
          dismissed: z.boolean().optional(),
          tasks: z
            .partialRecord(
              z.enum(homeChecklistTasks),
              z.object({
                clicked: z.boolean().optional(),
                dismissed: z.boolean().optional(),
                seen: z.number().int().nonnegative().optional(),
              }),
            )
            .optional(),
        })
        .optional(),
    })
    .optional(),
  // Claudex's earlier work types read as the original's roles that replaced
  // them; an unknown one is dropped rather than failing the whole file.
  workType: z.preprocess(
    (value) => (value === undefined ? undefined : normalizeWorkType(value)),
    z
      .enum(workTypes.map((w) => w.value) as [WorkType, ...WorkType[]])
      .optional(),
  ),
  notifyResponses: z.boolean().optional(),
  notifySchedules: z.boolean().optional(),
  notifySchedulesEmail: z.boolean().optional(),
  codeLocalSandbox: z.boolean().optional(),
  codeStrictSandbox: z.boolean().optional(),
  notifyCode: z.boolean().optional(),
  notifyCodePermissions: z.boolean().optional(),
  notifyCodeUpdates: z.boolean().optional(),
  notifyCodeEmail: z.boolean().optional(),
  allowBypassPermissions: z.boolean().optional(),
  classifySessionStates: z.boolean().optional(),
  ccPromptSuggestions: z.boolean().optional(),
  capabilityTipState: z
    .object({
      lastShownConversation: z.string().optional(),
      lastCountedConversation: z.string().optional(),
      sessionsSinceLastShow: z.number().int().nonnegative(),
      ledger: z.partialRecord(
        z.enum(capabilityTips),
        z.object({
          count: z.number().int().nonnegative(),
          lastSessionId: z.string().max(200),
        }),
      ),
      dismissed: z.array(z.enum(capabilityTips)).max(capabilityTips.length),
    })
    .optional(),
  ccNewTaskPrompt: z.enum(["ask", "here", "new_session"]).optional(),
  switchModelsOnFlag: z.boolean().optional(),
  modelAutoFallback: z.boolean().optional(),
  locationMetadata: z.boolean().optional(),
  autoArchiveDays: z
    .union([
      z.literal(0),
      z.literal(1),
      z.literal(2),
      z.literal(7),
      z.literal(14),
      z.literal(30),
    ])
    .optional(),
  codeOutputStyle: z.string().max(100).optional(),
  remoteControlNewSessions: z.boolean().optional(),
  taskPermission: z.enum(taskPermissions).optional(),
  keepAwakeWhileCoding: z.boolean().optional(),
  keepAwakeOnBattery: z.boolean().optional(),
  workflows: z
    .object({
      enabled: z.boolean().optional(),
      size: z.enum(["small", "medium", "large", "unrestricted"]).optional(),
      keywordTrigger: z.boolean().optional(),
    })
    .strict()
    .optional(),
  drawAttention: z.boolean().optional(),
  notificationLevels: z
    .object({
      permission: z.enum(notificationLevelValues).optional(),
      question: z.enum(notificationLevelValues).optional(),
      idle: z.enum(notificationLevelValues).optional(),
    })
    .strict()
    .optional(),
  notificationSound: z.enum(["system", "none"]).optional(),
  aiArtifacts: z.boolean().optional(),
  chatExecution: z.boolean().optional(),
  artifacts: z.boolean().optional(),
  designSystem: z.string().max(100).optional(),
  locale: z.enum(localeIds).optional(),
  apiGroups: z
    .record(
      z.string().min(1).max(40),
      z.number().int().min(1).max(2_147_483_647),
    )
    .refine((groups) => Object.keys(groups).length <= 30)
    .optional(),
  imageModel: z
    .string()
    .max(200)
    .regex(/^[\w.:/-]*$/)
    .optional(),
  networkEgress: z.boolean().optional(),
  egressAllowlist: z.enum(["none", "packages", "all"]).optional(),
  egressDomains: z
    .array(
      z
        .string()
        .max(253)
        .regex(/^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i),
    )
    .max(50)
    .optional(),
  breakReminderMinutes: z
    .number()
    .int()
    .min(0)
    .max(24 * 60)
    .optional(),
  quietHours: z
    .object({
      days: z.array(z.number().int().min(0).max(6)).max(7),
      start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    })
    .optional(),
  inlineVisualizations: z.boolean().optional(),
  toolAccessMode: z.enum(["needed", "loaded"]).optional(),
  connectorSearch: z.boolean().optional(),
  coworkInstructions: z.string().max(coworkInstructionsLimit).optional(),
  menuBar: z.boolean().optional(),
  keepAwake: z.boolean().optional(),
  /** The platform's offered accelerators are checked in `electron/settings-preferences.ts`. */
  quickAccessShortcut: z.string().max(100).optional(),
  quickEntryShortcut: z.string().max(100).optional(),
  quickEntryDictationShortcut: z
    .string()
    .max(100)
    .refine(
      (value) =>
        value === "off" || value === "capslock" || validAccelerator(value),
      "Choose a shortcut with a modifier key.",
    )
    .optional(),
  dictationShortcut: z
    .string()
    .max(100)
    .refine(
      (value) => value === "" || validAccelerator(value),
      "Choose a shortcut with a modifier key.",
    )
    .superRefine((value, context) => {
      if (value && !hasPrimaryModifier(value))
        context.addIssue({
          code: "custom",
          message: `Dictation shortcut "${value}" needs a Command or Control modifier`,
        });
    })
    .optional(),
  disabledSkills: z.array(z.string().min(1).max(4096)).max(1000).optional(),
  helpImproveClaudex: z.boolean().optional(),
  disableNonessentialServices: z.boolean().optional(),
  browserTools: z.boolean().optional(),
  allowAllBrowserActions: z.boolean().optional(),
  browserOpenLinksInApp: z.boolean().optional(),
  cloudSync: z.boolean().optional(),
  remoteControl: z.boolean().optional(),
  dispatchOnboarded: z.boolean().optional(),
  dispatchMobileNotifications: z.boolean().optional(),
  remoteFolders: z
    .array(z.string().refine(remoteFolderValid))
    .max(remoteFoldersLimit)
    .optional(),
  browserKeepCookies: z
    .enum(
      browserKeepCookiesOptions.map((o) => o.value) as [
        BrowserKeepCookies,
        ...BrowserKeepCookies[],
      ],
    )
    .optional(),
  browserAllowedSites: z
    .array(z.string().max(300).refine(allowedSiteValid))
    .max(browserAllowedSitesLimit)
    .optional(),
  browserAutoVerify: z.boolean().optional(),
  localEnvironmentVariables: z.string().max(envFileLimit).optional(),
  iosSimulatorAccess: z.boolean().optional(),
  androidEmulatorAccess: z.boolean().optional(),
  transcriptTextSize: z.enum(["s", "m", "l"]).optional(),
  transcriptWidth: z.enum(["s", "m", "l"]).optional(),
  preferredBrowser: z.literal("built_in").optional(),
  interfaceFont: z.enum(["anthropic", "system", "dyslexic"]).optional(),
  codeLightTheme: z.enum(["claudex-light", "github-light"]).optional(),
  codeDarkTheme: z.enum(["claudex-dark", "github-dark"]).optional(),
  defaultTranscriptView: z.enum(["normal", "thinking", "verbose"]).optional(),
  ccdThinkingSummaryOnDemand: z.boolean().optional(),
  coworkThinkingMode: z.enum(["standard", "extended"]).optional(),
  prAutoArchive: z.boolean().optional(),
  prOpenInBrowser: z.boolean().optional(),
  prAutoCreate: z.boolean().optional(),
  prAutoFix: z.boolean().optional(),
  prAutoCreateDraft: z.boolean().optional(),
  codeWorktree: z.boolean().optional(),
  codeWorktreeLocation: z.string().max(4096).optional(),
  codeBranchPrefix: z
    .string()
    .max(40)
    .refine((value) => value === "" || validBranchPrefix(value))
    .optional(),
  codeAutoCompactTokens: z.number().int().min(0).max(100_000_000).optional(),
} satisfies { [K in keyof SettingsPreferences]-?: z.ZodType };
