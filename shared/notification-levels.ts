/**
 * How loudly the desktop tells the person about its sessions (Settings →
 * Claudex Code → Local sessions). After the original's notification levels.
 *
 * A level the person never chose shows a banner and no Dock badge; one they
 * chose as Banners also counts in the badge, as in the original.
 */
export const notificationKinds = ["permission", "question", "idle"] as const;
export type NotificationKind = (typeof notificationKinds)[number];
export const notificationLevelValues = ["off", "badge", "banner"] as const;
export type NotificationLevel = (typeof notificationLevelValues)[number];
export type NotificationLevels = Partial<
  Record<NotificationKind, NotificationLevel>
>;
export type NotificationSound = "system" | "none";

/** What a level does: a banner, a count on the Dock icon, both or neither. */
export interface LevelEffect {
  banner: boolean;
  badge: boolean;
}

const effects: Record<NotificationLevel, LevelEffect> = {
  off: { banner: false, badge: false },
  badge: { banner: false, badge: true },
  banner: { banner: true, badge: true },
};
const unchosen: LevelEffect = { banner: true, badge: false };

interface LevelSettings {
  notificationLevels?: NotificationLevels;
  notifyCode?: boolean;
  notifyResponses?: boolean;
}

/**
 * The levels in force. Before the levels existed, Code requests were under
 * "Code permission requests" and finished turns under "Response
 * completions": a person who turned one of those off on purpose (stored
 * false; both were off by default) keeps that kind off until they choose a
 * level. Once levels are stored, the old switches no longer count.
 */
export function notificationLevels(
  settings: LevelSettings,
): NotificationLevels {
  if (settings.notificationLevels) return settings.notificationLevels;
  const levels: NotificationLevels = {};
  if (settings.notifyCode === false) {
    levels.permission = "off";
    levels.question = "off";
  }
  if (settings.notifyResponses === false) levels.idle = "off";
  return levels;
}

/** What one kind of notice does now. */
export function levelEffect(
  settings: LevelSettings,
  kind: NotificationKind,
): LevelEffect {
  const level = notificationLevels(settings)[kind];
  return level ? effects[level] : unchosen;
}

/**
 * The settings change that sets one kind's level: the levels in force
 * become stored, so the old switches stop counting from then on.
 */
export function levelPatch(
  settings: LevelSettings,
  kind: NotificationKind,
  level: NotificationLevel,
): { notificationLevels: NotificationLevels } {
  return {
    notificationLevels: { ...notificationLevels(settings), [kind]: level },
  };
}

/**
 * What saving one of the old switches must carry with it: the levels in
 * force, while none are stored, so turning the switch does not change the
 * desktop's banners (they follow the levels now).
 */
export function freezeLevels(settings: LevelSettings): {
  notificationLevels?: NotificationLevels;
} {
  return settings.notificationLevels
    ? {}
    : { notificationLevels: notificationLevels(settings) };
}

/**
 * Whether Settings shows the level and sound rows. The original keeps them
 * behind a flag, off by default, but shows them anyway once the person has a
 * level stored or the sound set to None. Claudex has no such flag; levels
 * carried over from the old switches count as stored, so a person whose banners
 * those switches turned off can turn them back on here.
 */
export function levelRowsShown(
  settings: LevelSettings & { notificationSound?: NotificationSound },
): boolean {
  return (
    Object.values(notificationLevels(settings)).some(
      (level) => level !== undefined,
    ) || settings.notificationSound === "none"
  );
}

/**
 * Draw attention bounces only for permission requests and questions: with
 * both off it has nothing to do, and the original disables its switch.
 */
export function attentionIdle(settings: LevelSettings): boolean {
  const levels = notificationLevels(settings);
  return levels.permission === "off" && levels.question === "off";
}
