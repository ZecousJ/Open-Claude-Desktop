import { lazy, Suspense, useState } from "react";
import { Lightbulb, ChevronLeft } from "../../ui/glyphs";
import { AppIcon } from "../../ui/app-icon";
import { Button, Row, Section, Toggle } from "../controls";
import type { TabProps } from "../context";
import { useHost } from "../../host/HostContext";
import { extensionFilePattern } from "../directory/directory-helpers";
import { usePolicy } from "../../policy/PolicyContext";
import { preference } from "../../../shared/settings-extras";
import { formatText, useT } from "../../i18n";
import { useLoaded } from "../pageControls";
import { ExtensionPolicyNotice } from "../ExtensionPolicyNotice";
import { ExtensionsIllustration } from "../directory/icons";
import "../directory/directory.css";
import "../developer.css";

const InstalledExtensions = lazy(() => import("./InstalledExtensions"));

/** Rows Settings search finds on this page. */
export { extensionsLabels as searchLabels } from "./desktop-labels";

/**
 * Extensions: the empty list, Browse extensions (the connectors directory, as
 * in the original), the .MCPB / .DXT drop target and Advanced settings.
 */
export function ExtensionsTab({ goTo, settings, save, onError }: TabProps) {
  const host = useHost();
  const policy = usePolicy();
  const disabled = policy.desktopExtensionsEnabled === false;
  const notice = disabled
    ? "Extensions are disabled on this device. Please contact your IT administrator to enable extensions."
    : undefined;
  const extensions = Object.entries(settings.mcpServers ?? {}).filter(
    ([, value]) =>
      value && typeof value === "object" && "claudex_extension" in value,
  );
  const desktop = host.capabilities.systemIntegration;
  const [advanced, setAdvanced] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [refused, setRefused] = useState<string>();
  if (advanced && desktop)
    return (
      <ExtensionSettings
        localMcp={host.capabilities.localMcp}
        onBack={() => setAdvanced(false)}
        goTo={goTo}
        settings={settings}
        save={save}
        onError={onError}
      />
    );
  return (
    <div
      className={`settings-intro-page directory-extensions ${dragging ? "dragging" : ""}`}
      onDragOver={(event) => {
        if (!desktop || disabled || !event.dataTransfer.types.includes("Files"))
          return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDragging(false);
      }}
      onDrop={async (event) => {
        if (!desktop || disabled) return;
        event.preventDefault();
        setDragging(false);
        setRefused(undefined);
        for (const file of [...event.dataTransfer.files]) {
          if (!extensionFilePattern.test(file.name)) continue;
          try {
            await window.desktop.installExtension({
              name: file.name,
              data: new Uint8Array(await file.arrayBuffer()),
            });
          } catch {
            setRefused("Couldn’t open the extension file. Try again.");
          }
        }
      }}
    >
      <header className="directory-header" data-setting="Extensions">
        <div className="settings-intro-heading">
          <h2>Extensions</h2>
          {!disabled && (
            <p>
              Allow Claudex to directly interact with apps, data, and tools on
              your computer.
            </p>
          )}
        </div>
        {!disabled && policy.localMcpEditing && (
          <button
            type="button"
            className="directory-outline-button"
            data-setting="Browse extensions"
            onClick={() => goTo("connectors")}
          >
            Browse extensions
          </button>
        )}
      </header>
      {notice && <ExtensionPolicyNotice message={notice} icon={false} />}
      {desktop && !disabled && (
        <Row label="Microsoft Office">
          <Button
            onClick={() =>
              window.dispatchEvent(new Event("claudex:office-addin"))
            }
          >
            Manage
          </Button>
        </Row>
      )}
      {extensions.length > 0 && (
        <>
          <Suspense fallback={<p role="status">Loading extensions…</p>}>
            <InstalledExtensions
              names={extensions.map(([name]) => name)}
              configuration={settings.mcpServers}
              onError={onError}
            />
          </Suspense>
          <button
            type="button"
            className="directory-outline-button"
            onClick={() => setAdvanced(true)}
          >
            Advanced settings
          </button>
        </>
      )}
      {extensions.length === 0 && !disabled && (
        <div className="settings-empty directory-extensions-empty">
          <ExtensionsIllustration />
          <p>No extensions installed</p>
          {desktop && (
            <button
              type="button"
              className="directory-outline-button"
              data-setting="Advanced settings"
              onClick={() => setAdvanced(true)}
            >
              Advanced settings
            </button>
          )}
          {desktop && policy.localMcpEditing && (
            <small className="directory-drop-hint">
              <Lightbulb size={14} />
              Drag .MCPB or .DXT files here to install
            </small>
          )}
          {refused && (
            <small className="directory-unavailable" role="status">
              {refused}
            </small>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Advanced settings: extension updates, the MCP Node.js choice, detected tools
 * and the developer install buttons.
 */
function ExtensionSettings({
  localMcp,
  onBack,
  goTo,
  settings,
  save,
  onError,
}: {
  localMcp: boolean;
  onBack: () => void;
  goTo: TabProps["goTo"];
  settings: TabProps["settings"];
  save: TabProps["save"];
  onError: TabProps["onError"];
}) {
  const tools = useLoaded(() => window.desktop.extensionTools(), onError);
  const policy = usePolicy();
  const t = useT();
  const installAllowed =
    policy.desktopExtensionsEnabled !== false && policy.localMcpEditing;
  return (
    <div className="desktop-page directory-extension-settings">
      <button type="button" className="directory-back" onClick={onBack}>
        <ChevronLeft size={16} />
        All extensions
      </button>
      <Section title="Extension settings">
        <Row
          label="Enable auto-updates for extensions"
          description="Automatically update extensions when new versions are available. If disabled, you'll need to manually update extensions."
        >
          <Toggle
            label="Enable auto-updates for extensions"
            checked={preference(settings, "extensionAutoUpdates")}
            onChange={(extensionAutoUpdates) =>
              void save({ extensionAutoUpdates })
            }
          />
        </Row>
        <Row
          label="Use built-in Node.js for MCP"
          description="If enabled, Claudex will never use the system Node.js for extension MCP servers. This happens automatically when the system's Node.js is missing or outdated."
        >
          <Toggle
            label="Use built-in Node.js for MCP"
            checked={preference(settings, "extensionBuiltInNode")}
            onChange={(extensionBuiltInNode) =>
              void save({ extensionBuiltInNode })
            }
          />
        </Row>
        <div className="extension-detected-tools">
          <p>Detected tools</p>
          {!tools.value && !tools.failed && (
            <span aria-busy="true">Loading…</span>
          )}
          {tools.value?.map((tool) => (
            <div key={tool.name}>
              <span>{tool.name}:</span>{" "}
              {tool.versions.join(", ") || t("Not found")}
              {tool.builtInVersion && (
                <span>
                  {" "}
                  {formatText("(built-in: {version})", {
                    version: tool.builtInVersion,
                  })}
                </span>
              )}
            </div>
          ))}
        </div>
      </Section>
      <Section title="Extension developer">
        <div className="directory-warning" role="note">
          <AppIcon name="Warning" size={16} />
          <div>
            <strong>Developer tools warning</strong>
            <p>
              These tools are intended for extension developers only. Using them
              incorrectly may cause extensions to malfunction or compromise your
              system security.
            </p>
          </div>
        </div>
        <div className="directory-button-pair">
          {installAllowed && (
            <>
              <Button
                primary
                size="regular"
                onClick={() =>
                  void window.desktop.installExtension().catch(onError)
                }
              >
                Install extension
              </Button>
              {policy.developerModeEnabled !== false && (
                <Button
                  size="regular"
                  onClick={() =>
                    void window.desktop
                      .installUnpackedExtension()
                      .catch(onError)
                  }
                >
                  Install unpacked extension
                </Button>
              )}
            </>
          )}
          <Button
            size="regular"
            onClick={() =>
              void window.desktop.openExtensionsFolder().catch(onError)
            }
          >
            Open extensions folder
          </Button>
          <Button
            size="regular"
            onClick={() =>
              void window.desktop.openExtensionSettingsFolder().catch(onError)
            }
          >
            Open extension settings folder
          </Button>
        </div>
        {localMcp && (
          <p className="directory-developer-link">
            Local MCP servers work in Claudex: add them under{" "}
            <button
              type="button"
              className="desktop-path-link"
              onClick={() => goTo("developer")}
            >
              Developer
            </button>
            .
          </p>
        )}
      </Section>
    </div>
  );
}
