import path from "node:path";
import { z } from "zod";
import type { Settings } from "../../shared/types";
import {
  desktopPreferenceFields,
  publicPreferences,
} from "./settings-preferences";

/** The settings a window may save (settings:save). */
const providerSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  baseUrl: z.string().max(2000),
  protocol: z.enum(["responses", "chat"]),
  model: z.string().max(200),
  models: z.array(z.string().max(200)).max(2000),
  transcriptionModel: z.string().min(1).max(200).optional(),
  hasApiKey: z.boolean().optional(),
});
/** The core settings, then the Settings-page preferences (shared/settings-extras-schema.ts). */
export const settingsSchema = z.object({
  theme: z.enum(["light", "dark", "system"]),
  sidebarWidth: z.number().int().min(188).max(460),
  name: z.string().max(100),
  providers: z.array(providerSchema).min(1).max(30),
  activeProviderId: z.string(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
  codeEffort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]),
  sandbox: z.enum(["read-only", "workspace-write"]),
  codeSandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]),
  bypassFolders: z
    .array(
      z
        .string()
        .max(4096)
        .refine((p) => path.isAbsolute(p), "Use an absolute folder path."),
    )
    .max(500)
    .optional(),
  autoAcceptEdits: z.boolean(),
  codePlanMode: z.boolean(),
  instructions: z.string().max(100000),
  mcpServers: z.record(z.string(), z.unknown()),
  chatFont: z.enum(["serif", "sans", "system", "dyslexia"]).optional(),
  motion: z.enum(["system", "reduced"]).optional(),
  codeFont: z
    .string()
    .max(200)
    .regex(/^[^;{}<>\\]*$/, "Use a font family name.")
    .optional(),
  hiddenNavItems: z
    .array(z.enum(["projects", "artifacts", "scheduled", "customize"]))
    .max(8)
    .optional(),
  ...desktopPreferenceFields(process.platform),
});

/** The settings the window may see: no service addresses or keys. */
export function publicSettingsOf(settings: Settings): Settings {
  return {
    theme: settings.theme,
    sidebarWidth: settings.sidebarWidth,
    name: settings.name,
    activeProviderId: settings.activeProviderId,
    effort: settings.effort,
    codeEffort: settings.codeEffort,
    sandbox: settings.sandbox,
    codeSandbox: settings.codeSandbox,
    bypassFolders: settings.bypassFolders,
    autoAcceptEdits: settings.autoAcceptEdits,
    codePlanMode: settings.codePlanMode,
    instructions: settings.instructions,
    mcpServers: settings.mcpServers,
    chatFont: settings.chatFont,
    motion: settings.motion,
    codeFont: settings.codeFont,
    hiddenNavItems: settings.hiddenNavItems,
    ...publicPreferences(settings),
    providers: settings.providers.map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: "",
      protocol: p.protocol,
      model: p.model,
      models: [...p.models],
      transcriptionModel: p.transcriptionModel,
      // Which service group serves each model (MG); no keys in it.
      ...(p.routes ? { routes: structuredClone(p.routes) } : {}),
    })),
  };
}
