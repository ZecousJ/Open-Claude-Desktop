import { useEffect, useRef, useState } from "react";
import type {
  DesktopExtensionDetails,
  DesktopExtensionSummary,
  DesktopExtensionsAPI,
  ExtensionValue,
} from "../../../shared/desktop-extensions-api";
import { extensionLifecycleMethods } from "../../../shared/desktop-extensions-api";
import { Button, SettingsModal, Toggle } from "../controls";
import { useAccountRead } from "../useAccountRead";
import type { TabProps } from "../context";
import { t, formatText } from "../../i18n";
import { MoreHorizontal } from "../../ui/glyphs";
import { Menu, type MenuPosition } from "../../ui/Menu";
import { usePolicy } from "../../policy/PolicyContext";
import { externalUrl, useOpenLink } from "../../ui/ExternalLinks";
import "./installed-extensions.css";

type Props = {
  names: string[];
  configuration?: object;
  onError: TabProps["onError"];
};
const api = (bridge: unknown) => bridge as DesktopExtensionsAPI;
const isSummary = (value: unknown): value is DesktopExtensionSummary =>
  !!value &&
  typeof value === "object" &&
  typeof (value as DesktopExtensionSummary).id === "string" &&
  typeof (value as DesktopExtensionSummary).name === "string";
const isDetails = (value: unknown): value is DesktopExtensionDetails =>
  isSummary(value) &&
  typeof (value as DesktopExtensionDetails).revision === "string" &&
  Array.isArray((value as DesktopExtensionDetails).fields) &&
  Array.isArray((value as DesktopExtensionDetails).tools) &&
  Array.isArray((value as DesktopExtensionDetails).prompts);

export default function InstalledExtensions({
  names,
  configuration,
  onError,
}: Props) {
  const policy = usePolicy();
  const editingAllowed =
    policy.localMcpEditing && policy.desktopExtensionsEnabled !== false;
  const supported = extensionLifecycleMethods.every(
    (method) =>
      typeof (
        typeof window === "undefined"
          ? undefined
          : (window.desktop as unknown as DesktopExtensionsAPI)
      )?.[method] === "function",
  );
  const list = useAccountRead(
    (bridge) => api(bridge).desktopExtensions(),
    (value): value is DesktopExtensionSummary[] =>
      Array.isArray(value) && value.every(isSummary),
    onError,
    false,
    supported,
  );
  const previous = useRef(configuration);
  useEffect(() => {
    if (previous.current !== configuration) {
      previous.current = configuration;
      if (supported) void list.reload();
    }
  }, [configuration, supported]);
  const [selected, setSelected] = useState<{
    id: string;
    configure: boolean;
    remove?: boolean;
  }>();
  if (!supported)
    return (
      <ul className="settings-list">
        {names.map((name) => (
          <li key={name} data-no-translate>
            {name}
          </li>
        ))}
      </ul>
    );
  return (
    <div className="installed-extensions">
      {list.loading && <p role="status">Loading extensions…</p>}
      {list.failed && (
        <div role="alert">
          <p>Couldn’t load installed extensions.</p>
          <Button onClick={() => void list.reload()}>Retry</Button>
        </div>
      )}
      {list.value?.map((extension) => (
        <article className="installed-extension-card" key={extension.id}>
          {extension.icon ? (
            <img src={extension.icon} width={42} height={42} alt="" />
          ) : (
            <span className="installed-extension-icon" aria-hidden="true">
              ◇
            </span>
          )}
          <div className="installed-extension-copy">
            <h3 data-no-translate>{extension.name}</h3>
            {extension.description && (
              <p data-no-translate>{extension.description}</p>
            )}
            {(!extension.enabled || extension.blockedReason) && (
              <span className="installed-extension-status">Disabled</span>
            )}
            {extension.blockedReason && <p>{t(extension.blockedReason)}</p>}
            {extension.error && <p role="status">{t(extension.error)}</p>}
          </div>
          {extension.owned && (
            <div className="installed-extension-actions">
              {extension.configurable && editingAllowed && (
                <Button
                  onClick={() =>
                    setSelected({ id: extension.id, configure: true })
                  }
                >
                  Configure
                </Button>
              )}
              <ExtensionMenu
                extension={{
                  ...extension,
                  uninstallable: extension.uninstallable && editingAllowed,
                }}
                onDetails={() =>
                  setSelected({ id: extension.id, configure: false })
                }
                onUninstall={() =>
                  setSelected({
                    id: extension.id,
                    configure: false,
                    remove: true,
                  })
                }
              />
            </div>
          )}
        </article>
      ))}
      {selected && (
        <ExtensionDetails
          key={selected.id}
          id={selected.id}
          configure={selected.configure}
          remove={selected.remove}
          onClose={() => setSelected(undefined)}
          onChanged={() => void list.reload()}
          onError={onError}
        />
      )}
    </div>
  );
}

function ExtensionMenu({
  extension,
  onDetails,
  onUninstall,
}: {
  extension: DesktopExtensionSummary;
  onDetails(): void;
  onUninstall(): void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuPosition>();
  const label = formatText("More options for {extension}", {
    extension: extension.name,
  });
  return (
    <>
      <button
        type="button"
        className="settings-button"
        ref={anchor}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        onClick={() => {
          const rect = anchor.current!.getBoundingClientRect();
          setMenu(
            menu
              ? undefined
              : { right: window.innerWidth - rect.right, top: rect.bottom + 4 },
          );
        }}
      >
        <MoreHorizontal size={16} />
      </button>
      {menu && (
        <Menu
          width="max-content"
          label={label}
          anchors={[anchor]}
          position={menu}
          onClose={() => setMenu(undefined)}
          entries={[
            { label: "Details", onSelect: onDetails },
            ...(extension.uninstallable
              ? [{ label: "Uninstall", danger: true, onSelect: onUninstall }]
              : []),
          ]}
        />
      )}
    </>
  );
}

function ExtensionDetails({
  id,
  configure,
  remove,
  onClose,
  onChanged,
  onError,
}: {
  id: string;
  configure: boolean;
  remove?: boolean;
  onClose(): void;
  onChanged(): void;
  onError: TabProps["onError"];
}) {
  const policy = usePolicy();
  const editingAllowed =
    policy.localMcpEditing && policy.desktopExtensionsEnabled !== false;
  const read = useAccountRead(
    (bridge) => api(bridge).desktopExtension(id),
    isDetails,
    onError,
  );
  const openLink = useOpenLink();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(remove === true);
  const [editing, setEditing] = useState(configure);
  const mutate = async (action: () => Promise<void>) => {
    if (!read.current() || busy || !editingAllowed) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      if (read.current()) onError(error);
    } finally {
      if (read.current()) setBusy(false);
    }
  };
  const details = read.value;
  return (
    <SettingsModal
      title={details?.name ?? t("Extension details")}
      onClose={busy ? () => {} : onClose}
    >
      {read.loading && <p role="status">Loading extension…</p>}
      {read.failed && (
        <div role="alert">
          <p>Couldn’t load this extension.</p>
          <Button onClick={() => void read.reload()}>Retry</Button>
        </div>
      )}
      {details && (
        <>
          <p data-no-translate>
            {details.longDescription ?? details.description}
          </p>
          <dl className="extension-metadata">
            {details.version && (
              <>
                <dt>Version</dt>
                <dd data-no-translate>{details.version}</dd>
              </>
            )}
            {details.author && (
              <>
                <dt>Author</dt>
                <dd data-no-translate>{details.author}</dd>
              </>
            )}
            {details.license && (
              <>
                <dt>License</dt>
                <dd data-no-translate>{details.license}</dd>
              </>
            )}
            {details.documentation && (
              <>
                <dt>Documentation</dt>
                <dd data-no-translate>
                  {externalUrl(details.documentation) ? (
                    <a
                      href={details.documentation}
                      onClick={(event) => {
                        event.preventDefault();
                        openLink(details.documentation!);
                      }}
                    >
                      {details.documentation}
                    </a>
                  ) : (
                    details.documentation
                  )}
                </dd>
              </>
            )}
            {details.support && (
              <>
                <dt>Support</dt>
                <dd data-no-translate>
                  {externalUrl(details.support) ? (
                    <a
                      href={details.support}
                      onClick={(event) => {
                        event.preventDefault();
                        openLink(details.support!);
                      }}
                    >
                      {details.support}
                    </a>
                  ) : (
                    details.support
                  )}
                </dd>
              </>
            )}
          </dl>
          {!!details.tools.length && (
            <section>
              <h3>Tools</h3>
              <ul>
                {details.tools.map((tool) => (
                  <li key={tool.name} data-no-translate>
                    <strong>{tool.name}</strong>
                    {tool.description && <p>{tool.description}</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {!!details.prompts.length && (
            <section>
              <h3>Prompts</h3>
              <ul>
                {details.prompts.map((prompt) => (
                  <li key={prompt.name} data-no-translate>
                    <strong>{prompt.name}</strong>
                    {prompt.description && <p>{prompt.description}</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {details.blockedReason && (
            <p role="status">{t(details.blockedReason)}</p>
          )}
          {details.configurationUnavailable && (
            <p role="status">{t(details.configurationUnavailable)}</p>
          )}
          {details.configurable && editingAllowed && !editing && (
            <Button onClick={() => setEditing(true)}>Configure</Button>
          )}
          {editing && details.configurable && editingAllowed && (
            <ExtensionForm
              key={details.revision}
              details={details}
              busy={busy}
              onSave={(enabled, values) =>
                void mutate(async () => {
                  if (!read.current()) return;
                  const next = await api(
                    read.owner.bridge,
                  ).saveDesktopExtension({
                    id,
                    revision: details.revision,
                    enabled,
                    values,
                  });
                  if (read.current()) {
                    read.setValue(next);
                    setEditing(false);
                    onChanged();
                  }
                })
              }
            />
          )}
          {confirming ? (
            <div className="extension-remove-confirm">
              <h3>Uninstall extension?</h3>
              <p>
                This removes the extension and its saved settings from this
                computer.
              </p>
              <Button disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void mutate(async () => {
                    if (!read.current()) return;
                    await api(read.owner.bridge).uninstallDesktopExtension({
                      id,
                      revision: details.revision,
                    });
                    if (read.current()) {
                      onChanged();
                      onClose();
                    }
                  })
                }
              >
                Uninstall
              </Button>
            </div>
          ) : (
            details.uninstallable &&
            editingAllowed && (
              <Button disabled={busy} onClick={() => setConfirming(true)}>
                Uninstall
              </Button>
            )
          )}
        </>
      )}
      <div className="button-row">
        <Button disabled={busy} onClick={onClose}>
          Close
        </Button>
      </div>
    </SettingsModal>
  );
}

function ExtensionForm({
  details,
  busy,
  onSave,
}: {
  details: DesktopExtensionDetails;
  busy: boolean;
  onSave(enabled: boolean, values: Record<string, ExtensionValue>): void;
}) {
  const [values, setValues] = useState<Record<string, ExtensionValue>>(
    details.values,
  );
  const [enabled, setEnabled] = useState(details.enabled);
  return (
    <form
      className="extension-configuration"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) onSave(enabled, values);
      }}
    >
      <label className="extension-enabled">
        Enabled
        <Toggle
          label="Enabled"
          checked={enabled}
          disabled={busy}
          onChange={setEnabled}
        />
      </label>
      {details.fields.map((field) => (
        <label key={field.key} className="extension-config-field">
          <span data-no-translate>{field.title}</span>
          {field.description && (
            <small data-no-translate>{field.description}</small>
          )}
          {field.type === "boolean" ? (
            <input
              aria-label={field.title}
              type="checkbox"
              checked={values[field.key] === true}
              disabled={busy}
              onChange={(event) =>
                setValues({ ...values, [field.key]: event.target.checked })
              }
            />
          ) : (
            <input
              aria-label={field.title}
              type={
                field.sensitive
                  ? "password"
                  : field.type === "number"
                    ? "number"
                    : "text"
              }
              value={String(values[field.key] ?? "")}
              required={
                field.required && !details.savedSecrets.includes(field.key)
              }
              placeholder={
                details.savedSecrets.includes(field.key)
                  ? t("Saved value")
                  : undefined
              }
              autoComplete="off"
              min={field.min}
              max={field.max}
              step={field.type === "number" ? "any" : undefined}
              disabled={busy}
              onChange={(event) => {
                const next = { ...values };
                if (
                  field.sensitive &&
                  event.target.value === "" &&
                  details.savedSecrets.includes(field.key)
                )
                  delete next[field.key];
                else
                  next[field.key] =
                    field.type === "number" && event.target.value !== ""
                      ? Number(event.target.value)
                      : event.target.value;
                setValues(next);
              }}
            />
          )}
        </label>
      ))}
      <button className="settings-button" type="submit" disabled={busy}>
        Save
      </button>
    </form>
  );
}
