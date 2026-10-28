/**
 * The person's computer-use settings (Settings → System → Computer use),
 * kept per account in `<profile>/computer-use.json`. Off by default.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  defaultComputerUseSettings,
  type ComputerUseSettings,
} from "../../shared/computer-use";

const appRef = z.object({
  id: z.string().trim().min(1).max(300),
  name: z.string().trim().min(1).max(200),
  platform: z.enum(["darwin", "win32", "linux"]),
});

export const settingsPatchSchema = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(["background", "fullControl"]),
    unhideApps: z.boolean(),
    deniedApps: z.array(appRef).max(100),
  })
  .partial()
  .strict();

const fileName = "computer-use.json";

export class ComputerUseSettingsStore {
  private value: ComputerUseSettings;
  constructor(private profile: string) {
    this.value = this.read();
  }

  private read(): ComputerUseSettings {
    try {
      const saved = settingsPatchSchema.safeParse(
        JSON.parse(fs.readFileSync(path.join(this.profile, fileName), "utf8")),
      );
      if (saved.success)
        return {
          ...structuredClone(defaultComputerUseSettings),
          ...saved.data,
        };
    } catch {}
    return structuredClone(defaultComputerUseSettings);
  }

  get(): ComputerUseSettings {
    return structuredClone(this.value);
  }

  /** Validates and stores a change; returns the new settings. */
  save(patch: unknown): ComputerUseSettings {
    const parsed = settingsPatchSchema.parse(patch);
    const next: ComputerUseSettings = { ...this.value, ...parsed };
    // One entry per app.
    const seen = new Set<string>();
    next.deniedApps = next.deniedApps.filter((app) => {
      const key = `${app.platform}:${app.id.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const target = path.join(this.profile, fileName);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, target);
    this.value = next;
    return this.get();
  }
}
