import { Section, Row, Toggle, SelectField } from "../controls";
import { t } from "../../i18n";
import {
  bypassPermissionsDescription,
  DynamicWorkflowsRow,
  WorktreeLocationRow,
} from "./ClaudeCode";
import { helpUrl } from "../../../shared/help-links";
import { bypassPatch } from "./desktop-labels";
import { LocalSandboxRows, NotificationLevelRows } from "./ClaudeCodeSections";
import { TrustedWorkspacesRow } from "./TrustedWorkspaces";
import {
  levelRowsShown,
  attentionIdle,
} from "../../../shared/notification-levels";
import { preference } from "../../../shared/settings-extras";
import { builtInOutputStyleNames } from "../../../shared/output-style-names";
import type { Settings } from "../../../shared/types";

/** What ClaudeCodeLocalSessions needs from ClaudeCode.tsx. */
export interface ClaudeCodePart2Props {
  allowBypass: boolean;
  keepAwake: boolean;
  onError: (error: unknown) => void;
  platform: NodeJS.Platform;
  save: (
    patch: Partial<Settings>,
    failure?: string | undefined,
    onFailure?: ((error: unknown) => void) | undefined,
  ) => void | Promise<boolean>;
  settings: Settings;
}

export function ClaudeCodeLocalSessions({
  allowBypass,
  keepAwake,
  onError,
  platform,
  save,
  settings,
}: ClaudeCodePart2Props) {
  return (
    <Section title="Local sessions">
      <Row
        label="Allow bypass permissions mode"
        description={
          <>
            {t(bypassPermissionsDescription)}{" "}
            <a
              className="code-bypass-security-link"
              href={helpUrl("code-security")}
              target="_blank"
              rel="noreferrer"
            >
              {t("See best practices for safe usage")}
            </a>
          </>
        }
      >
        <Toggle
          label="Allow bypass permissions mode"
          checked={allowBypass}
          onChange={(allow) => save(bypassPatch(settings, allow))}
        />
      </Row>
      <LocalSandboxRows
        settings={settings}
        save={save}
        windows={platform === "win32"}
        onError={onError}
      />
      {/* Code's "Trust this workspace?" answers, kept in Codex's config. */}
      <TrustedWorkspacesRow onError={onError} />
      <DynamicWorkflowsRow settings={settings} save={save} />
      {levelRowsShown(settings) && (
        <NotificationLevelRows settings={settings} save={save} />
      )}
      <Row
        label="Draw attention on notifications"
        description={
          platform === "darwin"
            ? "Bounce the Dock icon when Claudex needs your attention and the app isn’t focused."
            : platform === "win32"
              ? "Flash the taskbar button when Claudex needs your attention and the app isn’t focused."
              : "Flash the app icon when Claudex needs your attention and the app isn’t focused."
        }
      >
        <Toggle
          label="Draw attention on notifications"
          checked={preference(settings, "drawAttention")}
          disabled={levelRowsShown(settings) && attentionIdle(settings)}
          onChange={(drawAttention) => save({ drawAttention })}
        />
      </Row>
      {/* Shown where keeping this computer awake applies (the original
            hides it without codeSessionKeepAwake): not on the web. */}
      {
        <>
          <Row
            label="Keep computer awake while Claudex works"
            description="Prevent your computer from sleeping while a Code session is running, so long tasks can finish. Your display can still turn off. Closing the laptop lid will still put it to sleep."
          >
            <Toggle
              label="Keep computer awake while Claudex works"
              checked={keepAwake}
              onChange={(keepAwakeWhileCoding) =>
                save({ keepAwakeWhileCoding })
              }
            />
          </Row>
          {/* Only while the parent is on, as the original. */}
          {keepAwake && (
            <div className="desktop-subrow">
              <Row label="Keep awake on battery power">
                <Toggle
                  label="Keep awake on battery power"
                  checked={preference(settings, "keepAwakeOnBattery")}
                  onChange={(keepAwakeOnBattery) =>
                    save({ keepAwakeOnBattery })
                  }
                />
              </Row>
            </div>
          )}
        </>
      }
      {/* The original's other local-session rows. */}
      <Row
        label="Prompt suggestions"
        description="Show a suggested next prompt in the message box after Claudex replies. Suggestions add a little to your usage."
      >
        <Toggle
          label="Prompt suggestions"
          checked={preference(settings, "ccPromptSuggestions")}
          onChange={(ccPromptSuggestions) => save({ ccPromptSuggestions })}
        />
      </Row>
      <Row
        label="Archive inactive sessions"
        description="Automatically archive local sessions after a period of no activity. Sessions that are running or have background work are never archived, and a worktree with uncommitted changes is kept on disk."
      >
        <SelectField<string>
          label="Archive inactive sessions"
          value={String(preference(settings, "autoArchiveDays"))}
          width={160}
          options={[
            { value: "0", label: "Never" },
            { value: "1", label: "1 day" },
            { value: "2", label: "2 days" },
            { value: "7", label: "7 days" },
            { value: "14", label: "14 days" },
            { value: "30", label: "30 days" },
          ]}
          onChange={(value) =>
            save({
              autoArchiveDays: Number(value) as 0 | 1 | 2 | 7 | 14 | 30,
            })
          }
        />
      </Row>
      <WorktreeLocationRow settings={settings} save={save} />
      <Row
        label="When you ask for an unrelated task"
        description="A task that isn’t part of what a session is doing can run in its own linked session. Choose whether Claudex asks each time, keeps it in the session you typed it in, or opens a linked session for it."
      >
        <SelectField<"ask" | "here" | "new_session">
          label="When you ask for an unrelated task"
          value={preference(settings, "ccNewTaskPrompt")}
          width={220}
          options={[
            { value: "ask", label: "Ask me" },
            { value: "here", label: "Always do it here" },
            { value: "new_session", label: "Always start a new session" },
          ]}
          onChange={(ccNewTaskPrompt) => save({ ccNewTaskPrompt })}
        />
      </Row>
      <Row
        label="Output style"
        description="How Claudex structures its responses in Code sessions. Applies to new sessions; the session menu can override it for a single session."
      >
        <SelectField<string>
          label="Output style"
          value={preference(settings, "codeOutputStyle") || "default"}
          width={160}
          options={builtInOutputStyleNames.map((name) => ({
            value: name,
            label: name === "default" ? "Default" : name,
          }))}
          onChange={(style) =>
            save({ codeOutputStyle: style === "default" ? "" : style })
          }
        />
      </Row>
    </Section>
  );
}
