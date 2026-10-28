import type { Settings, Snapshot } from "../../shared/types";
import type { TabId } from "./nav";
import type { SettingsSkillsView } from "./skills-navigation";

/** What every Settings page receives. */
export interface TabProps {
  skillsView?: SettingsSkillsView;
  onSkillsViewChange?: (view: SettingsSkillsView) => void;
  settings: Settings;
  /**
   * Saves immediately; the original has no Save button. The answer says
   * whether it was kept; when it was not, `failure` (if given) is what the
   * error toast says instead of the error itself. `onFailure`, when given,
   * receives the error in place of the toast (a field that says why itself).
   */
  save: (
    patch: Partial<Settings>,
    failure?: string,
    onFailure?: (error: unknown) => void,
  ) => void | Promise<boolean>;
  platform: NodeJS.Platform;
  engine: Snapshot["engine"];
  email?: string;
  onSignOut?: () => Promise<void>;
  /** Revokes every session of a Sub2API account. */
  onSignOutEverywhere?: () => Promise<void>;
  onError: (error: unknown) => void;
  goTo: (tab: TabId) => void;
}
