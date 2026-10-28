import type { Settings } from "../../../shared/types";
import type { ClientPolicy } from "../../../shared/client-policy";
import { type NotificationKind } from "../../../shared/notification-levels";
import { useState } from "react";
import {
  browserKeepCookiesOptions,
  preference,
  type BrowserKeepCookies,
} from "../../../shared/settings-extras";
import { Button, Row, Section, SelectField, Toggle } from "../controls";
import { Dropdown } from "../Dropdown";
import { AllowedSitesDialog } from "../AllowedSitesDialog";
import {
  freezeLevels,
  levelPatch,
  notificationLevels,
  type NotificationLevel,
  type NotificationSound,
} from "../../../shared/notification-levels";
import { useHostCapability } from "../../host/HostContext";
import { usePolicy } from "../../policy/PolicyContext";
import type { TabProps } from "../context";
import { branchPrefixProblem } from "../../../shared/branch-prefix";
import { t } from "../../i18n";
import "../desktop.css";
import "../original-rows.css";

export function NotificationLevelRows({
  settings,
  save,
}: Pick<TabProps, "settings" | "save">) {
  const levels = notificationLevels(settings);
  return (
    <>
      {levelRows.map(({ kind, label, description, badge }) => (
        <Row key={kind} label={label} description={description}>
          <SelectField<NotificationLevel>
            label={`${label} notification level`}
            value={levels[kind] ?? "banner"}
            width={160}
            options={[
              { value: "off", label: "Off" },
              ...(badge
                ? [{ value: "badge" as const, label: "Badge only" }]
                : []),
              { value: "banner", label: "Banners" },
            ]}
            onChange={(level) => save(levelPatch(settings, kind, level))}
          />
        </Row>
      ))}
      <Row
        label="Notification sound"
        description="Played when an OS banner is shown."
      >
        <SelectField<NotificationSound>
          label="Notification sound"
          value={preference(settings, "notificationSound")}
          width={160}
          options={[
            { value: "system", label: "System sound" },
            { value: "none", label: "None" },
          ]}
          onChange={(notificationSound) =>
            save({ notificationSound, ...freezeLevels(settings) })
          }
        />
      </Row>
    </>
  );
}

/**
 * Settings → Claude Code → Browser: Browser tools, Open links in built-in
 * browser, Keep cookies and Allowed sites. Allowed sites only matter while
 * Claude can use the Browser tools, so the row is hidden while they are off;
 * the other two rows apply to browsing by hand as well. The administrator's
 * policy can turn the browser off (`policy.browser.enabled`): the switch then
 * shows off and disabled with the reason, and the rows about the browser itself
 * are hidden because it does not open.
 */
export function BrowserSection({
  settings,
  save,
}: Pick<TabProps, "settings" | "save">) {
  const available = useHostCapability("browserPanel");
  const policy = usePolicy();
  const [managing, setManaging] = useState(false);
  if (!available) return null;
  const { blocked, tools } = browserSectionState(settings, policy);
  return (
    <Section title="Browser">
      <Row
        label="Browser tools"
        description={
          blocked
            ? "Your administrator has turned off Browser tools."
            : "Claudex can start your dev servers, browse the web in a built-in browser, and verify changes with screenshots, snapshots, and DOM inspection."
        }
      >
        <Toggle
          label="Browser tools"
          checked={tools}
          disabled={blocked}
          onChange={(browserTools) => save({ browserTools })}
        />
      </Row>
      {!blocked && (
        <>
          <Row
            label="Open links in built-in browser"
            description="Links open in the built-in browser instead of your default browser."
          >
            <Toggle
              label="Open links in built-in browser"
              checked={preference(settings, "browserOpenLinksInApp")}
              onChange={(browserOpenLinksInApp) =>
                save({ browserOpenLinksInApp })
              }
            />
          </Row>
          <Row
            label="Keep cookies"
            description="Browser tabs keep cookies and logins across restarts in one saved browser shared by every session. Per session gives each Code session its own copy instead, so sessions never see each other’s logins."
          >
            <Dropdown<BrowserKeepCookies>
              label="Keep cookies"
              bordered
              width={220}
              value={preference(settings, "browserKeepCookies")}
              options={browserKeepCookiesOptions}
              onChange={(browserKeepCookies) => save({ browserKeepCookies })}
            />
          </Row>
        </>
      )}
      {tools && (
        <Row
          label="Allowed sites"
          description="Sites where Claudex can use its Browser tools without a permission prompt."
        >
          <Button onClick={() => setManaging(true)}>Manage</Button>
        </Row>
      )}
      {managing && tools && (
        <AllowedSitesDialog
          sites={preference(settings, "browserAllowedSites")}
          externalSites={policy.browser?.externalSites !== false}
          blockedDomains={policy.browser?.blockedDomains}
          onAdd={(site) =>
            save({
              browserAllowedSites: [
                ...preference(settings, "browserAllowedSites"),
                site,
              ],
            })
          }
          onRemove={(site) =>
            save({
              browserAllowedSites: preference(
                settings,
                "browserAllowedSites",
              ).filter((value) => value !== site),
            })
          }
          onClear={() => save({ browserAllowedSites: [] })}
          onClose={() => setManaging(false)}
        />
      )}
    </Section>
  );
}

/**
 * Local sandbox and Strict sandbox mode: both apply to new local Code sessions.
 * Off, commands run outside the sandbox but each untrusted one asks first;
 * strict refuses whatever can't run inside it (shared/sandbox-policy.ts). On
 * Windows, turning the sandbox on sets it up first, which asks for
 * administrator permission once.
 */
export function LocalSandboxRows({
  settings,
  save,
  windows,
  onError,
}: {
  settings: TabProps["settings"];
  save: TabProps["save"];
  windows: boolean;
  onError: (error: unknown) => void;
}) {
  const local = preference(settings, "codeLocalSandbox");
  const [setup, setSetup] = useState<"idle" | "busy" | "failed">("idle");
  return (
    <>
      <Row
        label="Local sandbox"
        description={
          <>
            {t(
              "Runs commands from Claudex Code in an isolated sandbox. Applies to new sessions.",
            )}
            {windows && !local && (
              <>
                {" "}
                {t("Turning this on asks for administrator permission once.")}
              </>
            )}
            {setup === "busy" && <> {t("Setting up...")}</>}
            {setup === "failed" && <> {t("Setup didn’t finish.")}</>}
          </>
        }
      >
        <Toggle
          label="Local sandbox"
          checked={local}
          disabled={setup === "busy"}
          onChange={async (codeLocalSandbox) => {
            if (codeLocalSandbox && windows) {
              setSetup("busy");
              try {
                await window.desktop.setupWindowsSandbox();
                setSetup("idle");
              } catch (error) {
                setSetup("failed");
                onError(error);
                return;
              }
            }
            await save({ codeLocalSandbox });
          }}
        />
      </Row>
      <div className="settings-indented">
        <Row
          label="Strict sandbox mode"
          description="Blocks commands that can’t run inside the sandbox (ssh, for example) instead of running them outside it or asking you. Applies to new sessions."
        >
          <Toggle
            label="Strict sandbox mode"
            checked={local && preference(settings, "codeStrictSandbox")}
            unavailable={
              local ? undefined : "Available when Local sandbox is on"
            }
            onChange={(codeStrictSandbox) => save({ codeStrictSandbox })}
          />
        </Row>
      </div>
    </>
  );
}

/**
 * Branch prefix: saved when the field is left; empty means "claude"; the reason
 * shows under it while it can't be used.
 */
export function BranchPrefixField({
  settings,
  save,
}: Pick<TabProps, "settings" | "save">) {
  const saved = preference(settings, "codeBranchPrefix");
  const [draft, setDraft] = useState<string>();
  const value = draft ?? saved;
  const problem = branchPrefixProblem(value.trim());
  return (
    <div className="branch-prefix">
      <input
        className="settings-input"
        aria-label="Branch prefix"
        dir="ltr"
        value={value}
        placeholder="claude"
        aria-invalid={problem !== null}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft === undefined) return;
          const next = draft.trim();
          if (branchPrefixProblem(next) !== null) return;
          setDraft(undefined);
          save({ codeBranchPrefix: next || "claude" });
        }}
      />
      <div
        role="status"
        className={problem ? "branch-prefix-error" : undefined}
      >
        {problem === "reserved"
          ? "This prefix is reserved for protected branches"
          : problem === "format"
            ? "Use 1-40 letters, numbers, or . _ -"
            : null}
      </div>
    </div>
  );
}

/**
 * A framed choice of the original's that Claudex cannot back yet, showing the
 * original's default.
 */
/**
 * The desktop's notification levels and sound. Permission requests and
 * Questions offer Off, Badge only and Banners; Task complete offers Off and
 * Banners. An unchosen level reads as Banners.
 */
export const levelRows: {
  kind: NotificationKind;
  label: string;
  description: string;
  badge: boolean;
}[] = [
  {
    kind: "permission",
    label: "Permission requests",
    description: "Claudex needs your approval to use a tool.",
    badge: true,
  },
  {
    kind: "question",
    label: "Questions",
    description: "Claudex is asking you to choose between options.",
    badge: true,
  },
  {
    kind: "idle",
    label: "Task complete",
    description: "Claudex finished and is waiting for your input.",
    badge: false,
  },
];

/**
 * The Browser section's switches: `blocked` when the administrator turned
 * the browser off, `tools` when Claude can use its Browser tools.
 */
export function browserSectionState(
  settings: Settings,
  policy: Pick<ClientPolicy, "browser">,
) {
  const blocked = policy.browser?.enabled === false;
  return { blocked, tools: !blocked && preference(settings, "browserTools") };
}
