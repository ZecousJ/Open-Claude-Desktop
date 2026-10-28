import { Suspense, useState } from "react";
import { lazyPiece } from "../../ui/lazy-piece";
import { Spinner } from "../../ui/Spinner";
import type { CodeEffort, Settings } from "../../../shared/types";
import { preference } from "../../../shared/settings-extras";
import { surface } from "../../../shared/host";
import {
  Button,
  Row,
  Section,
  SelectField,
  TextField,
  Toggle,
  Unavailable,
} from "../controls";
import { Dropdown } from "../Dropdown";
import { AllowedSitesDialog } from "../AllowedSitesDialog";
import { notAvailable } from "../unavailable";
import { CodeThemePickers } from "./CodeAppearance";
import { usePolicy } from "../../policy/PolicyContext";
import type { TabProps } from "../context";
import { effortChoices, sandboxChoices } from "./choices";
import { SshConnectionsSection } from "../../ssh/SshConnectionsSection";
import { MobileSimulatorsSection } from "../../simulators/MobileSimulatorsSection";
import { dynamicWorkflowsEnabled } from "../../../shared/code-session-settings";
import "../desktop.css";
import "../original-rows.css";
import { BrowserSection } from "./ClaudeCodeSections";
import { ClaudeCodePullRequests } from "./ClaudeCodePullRequests";
import { ClaudeCodeLocalSessions } from "./ClaudeCodeLocalSessions";
import { ClaudeCodeAppearance } from "./ClaudeCodeAppearance";

const CodeAccountSections = lazyPiece(() => import("./CodeAccountSections"));
const FontLicensesDialog = lazyPiece(
  () => import("../FontLicensesDialog"),
  "FontLicensesDialog",
);

/** Rows Settings search finds on this page. */
export { codeLabels as searchLabels } from "./desktop-labels";

/** The reference design. */
export const bypassPermissionsDescription =
  "Bypass all permission checks and let Claudex work uninterrupted. This works well for workflows like fixing lint errors or generating boilerplate code. Letting Claudex run arbitrary commands is risky and can result in data loss, system corruption, or data exfiltration (e.g., via prompt injection attacks).";

/**
 * Claude Code. Only the rows Claudex acts on: the default mode and effort, the
 * code font, the transcript view, and the local-session switches read by the
 * desktop integration (attention, keep awake) and the sandbox ("Allow bypass
 * permissions mode" is the user's own switch; no administrator policy changes
 * it, owner decision 3), and SSH connections for Code sessions on other
 * computers (R9; shown only when they work, src/ssh/availability.ts), and the
 * built-in Browser. The original's other rows are drawn as in the original,
 * disabled with the reason (owner rule: UI first). Mobile simulators follow the
 * Browser section; the page ends with the account and sharing rows
 * (CodeAccountSections). The original's Authorization tokens block (CLI OAuth
 * tokens) is not drawn: Claudex has no such tokens.
 */
export function ClaudeCodeTab({ settings, save, platform, onError }: TabProps) {
  const allowBypass = preference(settings, "allowBypassPermissions");
  const keepAwake = preference(settings, "keepAwakeWhileCoding");
  const [fontLicenses, setFontLicenses] = useState(false);
  return (
    <div className="desktop-page">
      <Section title="General">
        <Row
          label="Classify session states"
          description="Allow Claudex to automatically classify sessions as blocked, ready for review, or done. Classifying sessions counts towards your plan usage. Applies to new sessions."
        >
          <Toggle
            label="Classify session states"
            checked={preference(settings, "classifySessionStates")}
            onChange={(classifySessionStates) =>
              save({ classifySessionStates })
            }
          />
        </Row>
        <Row
          label="Switch models when a message is flagged"
          description={
            surface === "web"
              ? "When safeguards flag a message, automatically switch to a different model to keep chatting. When off, your session will pause instead. Applies to cloud sessions."
              : "When safeguards flag a message, automatically switch to a different model to keep chatting. When off, your session will pause instead. Applies to local sessions on this machine."
          }
        >
          <Toggle
            label="Switch models when a message is flagged"
            checked={preference(settings, "switchModelsOnFlag")}
            onChange={(switchModelsOnFlag) => save({ switchModelsOnFlag })}
          />
        </Row>
      </Section>
      <Section title="Code appearance">
        <CodeThemePickers settings={settings} save={save} onError={onError} />
        <Row
          label="Code font"
          description="Set a custom monospace font for code and terminal."
        >
          <TextField
            label="Code font family"
            placeholder="e.g. JetBrains Mono"
            value={settings.codeFont ?? ""}
            onCommit={(codeFont) => save({ codeFont: codeFont.trim() })}
          />
        </Row>
      </Section>
      {/* R-1361/R-1363: the transcript's own appearance. */}
      <ClaudeCodeAppearance
        save={save}
        setFontLicenses={setFontLicenses}
        settings={settings}
      />
      {surface !== "web" && (
        <>
          <Section title="Code defaults">
            <Row
              label="Default permissions"
              description="Where new Code sessions may write. Requests beyond it ask for approval in the conversation."
            >
              <Dropdown<Settings["codeSandbox"]>
                label="Default permissions"
                value={settings.codeSandbox}
                options={
                  settings.codeSandbox === "danger-full-access"
                    ? [
                        ...sandboxChoices,
                        {
                          value: "danger-full-access",
                          label: "Bypass permissions",
                        },
                      ]
                    : sandboxChoices
                }
                onChange={(codeSandbox) =>
                  save({
                    codeSandbox,
                    autoAcceptEdits: false,
                    codePlanMode: false,
                  })
                }
              />
            </Row>
            <Row
              label="Thinking effort"
              description="For models that support reasoning effort."
            >
              <Dropdown<CodeEffort>
                label="Thinking effort"
                value={settings.codeEffort}
                options={[
                  ...effortChoices,
                  { value: "ultra", label: "Ultracode" },
                ]}
                onChange={(codeEffort) => save({ codeEffort })}
              />
            </Row>
          </Section>
          <ClaudeCodeLocalSessions
            allowBypass={allowBypass}
            keepAwake={keepAwake}
            onError={onError}
            platform={platform}
            save={save}
            settings={settings}
          />
          <Section title="Remote Control">
            <Row
              label="Connect new sessions to Remote Control"
              description="Sessions you start on this computer connect to Remote Control automatically, so you can continue them from the terminal or the web."
            >
              <Toggle
                label="Connect new sessions to Remote Control"
                checked={preference(settings, "remoteControlNewSessions")}
                onChange={(remoteControlNewSessions) =>
                  save({ remoteControlNewSessions })
                }
              />
            </Row>
          </Section>
          <BrowserSection settings={settings} save={save} />
          <MobileSimulatorsSection
            settings={settings}
            save={save}
            platform={platform}
          />
        </>
      )}
      {/* Pull requests. */}
      <ClaudeCodePullRequests save={save} settings={settings} />
      {surface !== "web" && <SshConnectionsSection onError={onError} />}
      {surface !== "web" && platform === "win32" && (
        <WindowsSandbox onError={onError} />
      )}
      <Suspense fallback={null}>
        <CodeAccountSections onError={onError} />
      </Suspense>
      {fontLicenses && (
        <Suspense fallback={null}>
          <FontLicensesDialog
            onClose={() => setFontLicenses(false)}
            onError={onError}
          />
        </Suspense>
      )}
    </div>
  );
}

/**
 * Dynamic workflows: the account sets the default; administrator policy can
 * turn them off, which shows the switch off and disabled.
 */
export function DynamicWorkflowsRow({
  settings,
  save,
}: Pick<TabProps, "settings" | "save">) {
  const policy = usePolicy();
  const blocked = policy.workflows === false;
  return (
    <Row
      label="Dynamic workflows"
      description={
        blocked
          ? "Your administrator has turned off dynamic workflows."
          : "Let Claudex run multiple agents in parallel for complex tasks. Workflows can use a lot of your usage limit quickly."
      }
    >
      <Toggle
        label="Dynamic workflows"
        checked={dynamicWorkflowsEnabled(settings, policy)}
        disabled={blocked}
        onChange={(enabled) =>
          save({ workflows: { ...settings.workflows, enabled } })
        }
      />
    </Row>
  );
}

function UnavailableSelect({
  label,
  value,
  wide = false,
}: {
  label: string;
  value: string;
  wide?: boolean;
}) {
  return (
    <Unavailable reason={notAvailable}>
      <SelectField<string>
        label={label}
        value={value}
        width={wide ? 220 : 160}
        options={[{ value, label: value }]}
        disabled
        onChange={() => {}}
      />
    </Unavailable>
  );
}

function WindowsSandbox({ onError }: { onError: (error: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  return (
    <Section title="Windows sandbox">
      <Row
        label="Set up the sandbox"
        description={
          result || "Run once before your first task on this computer."
        }
      >
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setResult((await window.desktop.setupWindowsSandbox()).message);
            } catch (error) {
              onError(error);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy && <Spinner inheritColor size={14} className="spin" />}
          Set up
        </Button>
      </Row>
    </Section>
  );
}

// The dialog moved to ../AllowedSitesDialog so the browser panel can use it too.
export { AllowedSitesContent, siteLabel } from "../AllowedSitesDialog";
export { AllowedSitesDialog };

/**
 * Worktree location: Inside project (.claude/worktrees) or Custom…, which asks
 * for a folder and shows it under the select.
 */
export function WorktreeLocationRow({
  settings,
  save,
}: Pick<TabProps, "settings" | "save">) {
  const location = preference(settings, "codeWorktreeLocation");
  return (
    <Row
      label="Worktree location"
      description="Where to store Git worktrees for isolated coding sessions on this computer. SSH sessions use the Worktree folder setting on each SSH connection."
    >
      <div className="worktree-location">
        <SelectField<"default" | "custom">
          label="Worktree location"
          value={location ? "custom" : "default"}
          width={220}
          options={[
            { value: "default", label: "Inside project (.claude/worktrees)" },
            { value: "custom", label: "Custom…" },
          ]}
          onChange={async (choice) => {
            if (choice === "default") return save({ codeWorktreeLocation: "" });
            const folder =
              await window.desktop?.chooseFolder?.("Worktree location");
            if (folder) save({ codeWorktreeLocation: folder });
          }}
        />
        {location && (
          <small className="worktree-location-path" title={location}>
            {location}
          </small>
        )}
      </div>
    </Row>
  );
}
