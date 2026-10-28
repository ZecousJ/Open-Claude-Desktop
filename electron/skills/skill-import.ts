import type {
  SkillImportFile,
  SkillImportOutcome,
} from "../../shared/skill-import";
import { installSkillFile } from "./skill-folder";
import {
  skillImportLimits,
  skillImportNotice,
} from "../../shared/skill-import";

const catalogs: Record<
  string,
  () => Promise<{ default: Record<string, string> }>
> = {
  "zh-CN": () => import("../../shared/i18n/catalogs/zh-CN"),
  "ja-JP": () => import("../../shared/i18n/catalogs/ja-JP"),
  "ko-KR": () => import("../../shared/i18n/catalogs/ko-KR"),
  "de-DE": () => import("../../shared/i18n/catalogs/de-DE"),
  "fr-FR": () => import("../../shared/i18n/catalogs/fr-FR"),
  "es-ES": () => import("../../shared/i18n/catalogs/es-ES"),
  "es-419": () => import("../../shared/i18n/catalogs/es-419"),
  "it-IT": () => import("../../shared/i18n/catalogs/it-IT"),
  "pt-BR": () => import("../../shared/i18n/catalogs/pt-BR"),
  "id-ID": () => import("../../shared/i18n/catalogs/id-ID"),
  "hi-IN": () => import("../../shared/i18n/catalogs/hi-IN"),
};

export async function skillImportNotification(
  added: number,
  remaining: number,
  locale: string,
) {
  const notice = skillImportNotice(added, remaining);
  const catalog: Record<string, string> =
    (await catalogs[locale]?.().catch(() => ({ default: {} })))?.default ?? {};
  const values: Record<string, number> = { n: added, total: added + remaining };
  const translate = (text: string) =>
    (catalog[text] ?? text).replace(/\{(\w+)\}/g, (whole, key) =>
      String(values[key] ?? whole),
    );
  return {
    title: translate(notice.title),
    body: [
      translate(notice.detail),
      notice.remaining && translate(notice.remaining),
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

// Keep failures reviewable without rolling back successful uploads.
export function importSkillFiles(
  folder: string,
  files: SkillImportFile[],
): SkillImportOutcome[] {
  return files.map((file) => {
    try {
      return {
        file: file.name,
        name: installSkillFile(
          folder,
          {
            name: file.name,
            data: Buffer.from(file.data),
          },
          false,
          skillImportLimits,
        ),
        ok: true,
      };
    } catch (error) {
      return {
        file: file.name,
        message: error instanceof Error ? error.message : String(error),
        ok: false,
      };
    }
  });
}
