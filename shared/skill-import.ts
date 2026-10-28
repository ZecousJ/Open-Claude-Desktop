export interface SkillImportFile {
  name: string;
  data: Uint8Array;
}

export const skillImportLimits = {
  files: 200,
  bytes: 30 * 1024 * 1024,
  message: "Skill files are too large to upload.",
};

export type SkillImportOutcome =
  | { file: string; name: string; ok: true }
  | { file: string; message: string; ok: false };

export function skillImportNotice(added: number, remaining: number) {
  const total = added + remaining;
  return {
    title: remaining
      ? total === 1
        ? "{n} of {total} skill uploaded from Claudex (third-party)"
        : "{n} of {total} skills uploaded from Claudex (third-party)"
      : added === 1
        ? "{n} skill uploaded from Claudex (third-party)"
        : "{n} skills uploaded from Claudex (third-party)",
    detail:
      added === 1
        ? "See it in Customize › Skills."
        : "See them in Customize › Skills.",
    remaining: remaining ? "Find the rest in Settings › Import." : undefined,
  };
}
