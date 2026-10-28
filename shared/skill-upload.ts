/**
 * The Upload skill page's name clash: `installSkillFiles` refuses a skill whose
 * name is already installed with this message, and the page reads the name
 * back out of it to offer Replace or Skip (the original's "A skill named
 * {skillName} already exists" row).
 */
export const skillExistsMessage = (name: string) =>
  `A skill named "${name}" is already installed.`;

/** The name in a clash message (the error may carry a transport prefix), else undefined. */
export function skillExistsName(message: string): string | undefined {
  return /A skill named "([^"]+)" is already installed\./.exec(message)?.[1];
}

/** How the page tells the main process to treat a name that is taken. */
export interface InstallSkillOptions {
  /** Replace the installed skill of the same name instead of refusing. */
  replace?: boolean;
}

export const skillFileTypes = [".md", ".zip", ".skill"];
export const acceptsSkillFile = (name: string) =>
  skillFileTypes.some((type) => name.toLowerCase().endsWith(type));
