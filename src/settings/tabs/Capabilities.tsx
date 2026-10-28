import { localEgressSupported } from "../../../shared/local-egress";
import { helpUrl } from "../../../shared/help-links";
import { Info, Trash2 } from "../../ui/glyphs";
import { useRef, useState } from "react";
import {
  useSettingsRequestScope,
  type SettingsScopeOwner,
} from "../useSettingsRequestScope";
import { useHost } from "../../host/HostContext";
import type { CloudNetworkLevel } from "../../../shared/host";
import { Row, Section, SelectField, Toggle, Unavailable } from "../controls";
import { Dropdown } from "../Dropdown";
import type { TabProps } from "../context";
import { isEditEndKey } from "../../ui/ime";
import { showToast } from "../../ui/toast-store";
import { preference } from "../../../shared/settings-extras";
import { chatArtifactsEnabled } from "../../../shared/chat-execution";
import { formatText, t } from "../../i18n";
import "../original-rows.css";

/** A translated sentence whose `<a>…</a>` part is a link. */
function WithLink({ text, href }: { text: string; href: string }) {
  const [before, rest = ""] = t(text).split("<a>");
  const [linked, after = ""] = rest.split("</a>");
  return (
    <>
      {before}
      <a href={href} target="_blank" rel="noreferrer">
        {linked}
      </a>
      {after}
    </>
  );
}

/** A sentence linking to the security article. */
function WithSecurityLink({ text }: { text: string }) {
  return <WithLink text={text} href={helpUrl("files-and-code")} />;
}

/** Rows Settings search finds on this page. */
export { capabilitiesLabels as searchLabels } from "./desktop-labels";

/** Says what a switch now does once it is saved (the original's toasts); a refused save has its own error. */
async function saved(result: ReturnType<TabProps["save"]>, message: string) {
  if ((await result) !== false) showToast(message);
}

/**
 * Current standalone Capabilities. Tool access, connector search, model
 * fallback and visuals use the account's real preferences. Web sandbox
 * network preferences narrow the service ceiling. A host without that
 * capability shows its actual boundary instead of a nonfunctional editor.
 */
export function CapabilitiesTab(props: TabProps) {
  const scope = useSettingsRequestScope();
  return <CapabilitiesControl key={scope.key} {...props} scope={scope} />;
}

function CapabilitiesControl({
  goTo,
  platform,
  settings,
  save,
  scope,
}: TabProps & { scope: SettingsScopeOwner }) {
  const execution = preference(settings, "chatExecution");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();
  const saving = useRef(false);
  const change = async (
    patch: Partial<TabProps["settings"]>,
    message?: string,
  ) => {
    const request = scope.capture();
    if (saving.current || !request.current()) return;
    saving.current = true;
    setPending(true);
    setFailure(undefined);
    try {
      if ((await save(patch)) === false) {
        if (request.current())
          setFailure("Couldn’t save your change. Try again.");
      } else if (message && request.current()) showToast(message);
    } catch {
      if (request.current())
        setFailure("Couldn’t save your change. Try again.");
    } finally {
      saving.current = false;
      if (request.current()) setPending(false);
    }
  };
  // The web: the sandbox's network is real, narrowed from what the service
  // allows. This computer: Chat's code runs in the local sandbox, whose
  // network these settings open (shared/local-egress.ts), up to all domains.
  const host = useHost();
  const network = host.sandboxNetwork;
  // (Windows' sandbox has no domain proxy yet: shared/local-egress.ts.)
  const egressCeiling =
    network ??
    (host.kind === "desktop" && localEgressSupported(platform)
      ? ("full" as const)
      : undefined);
  return (
    <>
      <Section title="General">
        <Row
          label="Tool access mode"
          description="Controls how connector tools are loaded in new conversations."
        >
          {/* The original's ghost select with a described choice in a 22rem
             list. The default for conversations without their own Tool access
             choice, from their next message (shared/tool-search-mode.ts). */}
          <Dropdown<"needed" | "loaded">
            label="Tool access mode"
            value={preference(settings, "toolAccessMode")}
            menuWidth={352}
            options={[
              {
                value: "needed",
                label: "Load tools when needed",
                description:
                  "Chats compact less since tools aren’t pre-loaded.",
              },
              {
                value: "loaded",
                label: "Tools already loaded",
                description:
                  "Chats compact more often since tools are always there.",
              },
            ]}
            onChange={(toolAccessMode) =>
              saved(
                save({ toolAccessMode }),
                toolAccessMode === "needed"
                  ? "Tool access set to load when needed"
                  : "Tool access set to load all tools up front",
              )
            }
          />
        </Row>
        <Row
          label="Connector search"
          description="Let Claudex search the connector directory and surface ones relevant to your conversation."
        >
          <Toggle
            label="Connector search"
            checked={preference(settings, "connectorSearch")}
            onChange={(connectorSearch) => save({ connectorSearch })}
          />
        </Row>
        <Row
          label="Switch models when a message is flagged"
          description="When safeguards flag a message, automatically switch to a different model to keep chatting. When off, your chat will pause instead."
        >
          {/* No confirmation toast, as the original. */}
          <Toggle
            label="Switch models when a message is flagged"
            checked={preference(settings, "modelAutoFallback")}
            onChange={(modelAutoFallback) => save({ modelAutoFallback })}
          />
        </Row>
      </Section>
      <Section title="Visuals">
        <Row
          label="Artifacts"
          description={
            execution ? (
              // Locked on by code execution: a second muted line under the
              // description says why.
              <span className="settings-row-notes">
                <span>
                  {t(
                    "Generate code, documents, and designs in a dedicated window alongside your conversation.",
                  )}
                </span>
                <span>
                  {t("Required for code execution and file creation")}
                </span>
              </span>
            ) : (
              "Generate code, documents, and designs in a dedicated window alongside your conversation."
            )
          }
        >
          {execution ? (
            <Unavailable reason="Disable code execution and file creation to change this setting.">
              <Toggle label="Artifacts" checked disabled />
            </Unavailable>
          ) : (
            <Toggle
              label="Artifacts"
              checked={chatArtifactsEnabled(settings)}
              disabled={pending}
              onChange={(artifacts) =>
                void change(
                  { artifacts },
                  artifacts ? "Artifacts enabled" : "Artifacts disabled",
                )
              }
            />
          )}
        </Row>
        <Row
          label="AI-powered artifacts"
          description="Build apps and interactive documents that use Claudex inside the artifact."
        >
          <Toggle
            label="AI-powered artifacts"
            checked={preference(settings, "aiArtifacts")}
            onChange={(aiArtifacts) =>
              saved(
                save({ aiArtifacts }),
                aiArtifacts
                  ? "AI-powered artifacts enabled"
                  : "AI-powered artifacts disabled",
              )
            }
          />
        </Row>
        <Row
          label="Inline visualizations"
          description="Allow Claudex to generate interactive visualizations, charts, and diagrams directly in the conversation."
        >
          <Toggle
            label="Inline visualizations"
            checked={preference(settings, "inlineVisualizations")}
            onChange={(inlineVisualizations) =>
              saved(
                save({ inlineVisualizations }),
                inlineVisualizations
                  ? "Inline visualizations enabled"
                  : "Inline visualizations disabled",
              )
            }
          />
        </Row>
      </Section>
      <Section title="Code execution and file creation">
        <Row
          label={
            network
              ? "Run code in the cloud"
              : "Code execution and file creation"
          }
          description={
            <span className="capabilities-description-stack">
              <span>
                {network
                  ? "Claudex can execute code on a server and create and edit docs, spreadsheets, presentations, PDFs, and data reports. Required for skills."
                  : "Claudex can execute code and create and edit docs, spreadsheets, presentations, PDFs, and data reports. Required for skills."}
              </span>
              {/* Shown where the network settings below are not offered, as in
                 the original. */}
              {!egressCeiling && (
                <span>
                  <WithSecurityLink text="This feature gives Claudex network access to create and analyze files, which has <a>security risks</a>. Monitor chats closely when using this feature." />
                </span>
              )}
            </span>
          }
        >
          <Toggle
            label={
              network
                ? "Run code in the cloud"
                : "Code execution and file creation"
            }
            checked={execution}
            disabled={pending}
            onChange={(chatExecution) => void change({ chatExecution })}
          />
        </Row>
        <p className="settings-section-note" role="status">
          Applies to Chat. Changes take effect with your next message.
        </p>
        {failure && (
          <p className="settings-section-note" role="alert">
            {failure}
          </p>
        )}
        {egressCeiling ? (
          <NetworkEgress
            settings={settings}
            save={save}
            ceiling={egressCeiling}
          />
        ) : (
          <p className="settings-section-note" role="status">
            Network restrictions are available only in a supported cloud
            sandbox. Local sessions use their selected sandbox and permission
            settings.
          </p>
        )}
      </Section>
      <Section title="Skills">
        <p className="capabilities-moved">
          Skills have moved to{" "}
          <button type="button" onClick={() => goTo("skills")}>
            Customize
          </button>
          .
        </p>
      </Section>
    </>
  );
}

const domainPattern =
  /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/**
 * Allow network egress, Domain allowlist and Additional allowed domains On the
 * web, where a task runs in a sandbox on the server: the service's level is the
 * ceiling and these only narrow it (net-policy.ts `userNetworkPolicy`). "All
 * domains" needs a service that allows them.
 */
type NetworkEgressProps = {
  settings: TabProps["settings"];
  save: TabProps["save"];
  ceiling: CloudNetworkLevel;
};
export function NetworkEgress(props: NetworkEgressProps) {
  const scope = useSettingsRequestScope();
  return <NetworkEgressControl key={scope.key} {...props} scope={scope} />;
}
function NetworkEgressControl({
  settings,
  save,
  ceiling,
  scope,
}: NetworkEgressProps & { scope: SettingsScopeOwner }) {
  const enabled = preference(settings, "networkEgress");
  const allowlist = preference(settings, "egressAllowlist");
  const domains = preference(settings, "egressDomains");
  const [draft, setDraft] = useState("");
  const [blurred, setBlurred] = useState(false);
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const [failure, setFailure] = useState<string>();
  const closed = ceiling === "none";
  const on = enabled && !closed;
  // The original's rules: Add stays off for an empty, invalid or listed domain,
  // and the invalid note shows once the field is left.
  const value = draft.trim().toLowerCase();
  const valid = value.length <= 253 && domainPattern.test(value);
  const listed = domains.includes(value);
  const change = async (patch: Partial<TabProps["settings"]>) => {
    const request = scope.capture();
    if (saving.current || closed || !request.current()) return false;
    saving.current = true;
    setPending(true);
    setFailure(undefined);
    try {
      const result = await save(patch);
      if (!request.current()) return false;
      if (result === false) {
        setFailure("Couldn’t save your change. Try again.");
        return false;
      }
      return true;
    } catch {
      if (request.current())
        setFailure("Couldn’t save your change. Try again.");
      return false;
    } finally {
      saving.current = false;
      if (request.current()) setPending(false);
    }
  };
  const add = async () => {
    if (!value || !valid || listed || domains.length >= 50 || pending || !on)
      return;
    const request = scope.capture();
    if (
      (await change({ egressDomains: [...domains, value] })) &&
      request.current()
    ) {
      setDraft("");
      setBlurred(false);
    }
  };
  return (
    <div className="capabilities-network" aria-busy={pending}>
      <Row
        label="Allow network egress"
        description={
          <WithSecurityLink text="Give Claudex network access to install packages and libraries in order to perform advanced data analysis, custom visualizations, and specialized file processing. Monitor chats closely as this comes with <a>security risks</a>." />
        }
      >
        {closed ? (
          <Toggle
            label="Allow network egress"
            checked={false}
            unavailable="Your administrator has turned the network off for tasks."
          />
        ) : (
          <Toggle
            label="Allow network egress"
            checked={on}
            disabled={pending}
            onChange={(networkEgress) => void change({ networkEgress })}
          />
        )}
      </Row>
      {failure && <p role="alert">{failure}</p>}
      {on && (
        <div className="capabilities-allowlist">
          <Row
            label="Domain allowlist"
            description="Choose which domains the sandbox can access"
          >
            <SelectField<string>
              label="Domain allowlist"
              value={allowlist}
              disabled={pending}
              options={[
                { value: "none", label: "None" },
                { value: "packages", label: "Package managers only" },
                {
                  value: "all",
                  label: "All domains",
                  ...(ceiling === "full"
                    ? {}
                    : {
                        unavailable: "Your administrator limits the domains.",
                      }),
                },
              ]}
              onChange={(egressAllowlist) =>
                void change({
                  egressAllowlist: egressAllowlist as
                    "none" | "packages" | "all",
                })
              }
            />
          </Row>
          <p className="capabilities-allowlist-note" role="status">
            <Info size={20} strokeWidth={1.5} aria-hidden="true" />
            <span>
              {allowlist === "all" ? (
                t("Claudex can access all domains on the internet.")
              ) : allowlist === "none" ? (
                t(
                  "Claudex can only access domains you specify below. Add domains individually using wildcards if needed.",
                )
              ) : (
                <WithLink
                  href={helpUrl("cloud-environments")}
                  text="Claudex can access common package managers plus any additional domains you specify below. <a>View package manager domains</a>."
                />
              )}
            </span>
          </p>
          {allowlist !== "all" && (
            <>
              <label
                className="capabilities-allowlist-label"
                htmlFor="cap-domains"
              >
                Additional allowed domains
              </label>
              <div className="capabilities-allowlist-add">
                <input
                  id="cap-domains"
                  className="settings-input"
                  placeholder="example.com or *.example.com"
                  dir="ltr"
                  value={draft}
                  disabled={pending}
                  maxLength={253}
                  data-invalid={blurred && value && !valid ? "" : undefined}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setBlurred(false);
                  }}
                  onBlur={() => setBlurred(true)}
                  onKeyDown={(event) => {
                    if (isEditEndKey(event, "Enter")) {
                      event.preventDefault();
                      add();
                    }
                  }}
                />
                <button
                  type="button"
                  className="settings-button primary regular"
                  disabled={
                    !value ||
                    !valid ||
                    listed ||
                    pending ||
                    domains.length >= 50
                  }
                  onClick={() => void add()}
                >
                  Add
                </button>
              </div>
              {blurred && value && !valid && (
                <p className="capabilities-allowlist-error" role="alert">
                  Enter a valid domain (e.g., example.com or *.example.com)
                </p>
              )}
              {domains.length > 0 && (
                <ul className="capabilities-allowlist-domains">
                  {domains.map((domain) => (
                    <li key={domain}>
                      <bdi dir="ltr">{domain}</bdi>
                      <button
                        type="button"
                        aria-label={formatText("Remove {host}", {
                          host: domain,
                        })}
                        disabled={pending}
                        onClick={() =>
                          void change({
                            egressDomains: domains.filter((d) => d !== domain),
                          })
                        }
                      >
                        <Trash2 size={16} strokeWidth={1.5} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
