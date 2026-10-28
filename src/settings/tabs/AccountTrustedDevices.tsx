import "../active-sessions.css";
import "./account-trusted-devices.css";
import { useRef, useState } from "react";
import type {
  DeviceTrustAPI,
  DeviceTrustClient,
  DeviceTrustState,
} from "../../../shared/remote-devices";
import { deviceTrustBridgeMethods } from "../../../shared/remote-devices";
import { surface } from "../../../shared/host";
import { webMethodKind } from "../../../shared/web-bridge-methods";
import type { DesktopAPI } from "../../../shared/types";
import { helpUrl } from "../../../shared/help-links";
import { currentLocale, formatText, t } from "../../i18n";
import { MoreVertical, ChevronLeft, ChevronRight } from "../../ui/glyphs";
import { Menu, type MenuPosition } from "../../ui/Menu";
import {
  Button,
  Row,
  Section,
  Toggle,
  SettingsModal,
  Unavailable,
} from "../controls";
import type { TabProps } from "../context";
import { useAccountRead } from "../useAccountRead";
import { AccountDevicesSection } from "./AccountDevices";

const isClient = (value: unknown): value is DeviceTrustClient => {
  const client = value as DeviceTrustClient | undefined;
  return (
    !!client &&
    typeof client.id === "string" &&
    typeof client.name === "string" &&
    typeof client.platform === "string" &&
    typeof client.fingerprint === "string" &&
    typeof client.addedAt === "string" &&
    Number.isFinite(Date.parse(client.addedAt))
  );
};
const isState = (value: unknown): value is DeviceTrustState => {
  const state = value as DeviceTrustState | undefined;
  return (
    !!state &&
    typeof state.requireTrustedDevices === "boolean" &&
    Array.isArray(state.trusted) &&
    state.trusted.every(isClient) &&
    Array.isArray(state.pending) &&
    state.pending.every(isClient)
  );
};

/** Owner approval occurs only through the current signed-in window's IPC.
 * The remote client must compare its fingerprint before requesting approval. */
export function AccountDeviceSettings({
  onError,
  paged = true,
}: Pick<TabProps, "onError"> & { paged?: boolean }) {
  const bridge = typeof window === "undefined" ? undefined : window.desktop;
  // The web bridge answers every name with a function that throws "Not
  // available on the web." for an absent call, so on the web the table of
  // web kinds decides; opening Account must not raise that error.
  const supported = deviceTrustBridgeMethods.every(
    (method) =>
      typeof bridge?.[method] === "function" &&
      (surface !== "web" || webMethodKind(method) !== "absent"),
  );
  const trust = useAccountRead(
    (bridge) => (bridge as DesktopAPI & DeviceTrustAPI).deviceTrustState(),
    isState,
    onError,
    true,
    supported,
  );
  const [busyOwner, setBusyOwner] = useState<object>();
  const busy = busyOwner === trust.owner;
  const mutating = useRef<{ owner: object } | undefined>(undefined);
  const [pageChoice, setPageChoice] = useState<{
    owner: object;
    page: number;
  }>();
  const [removal, setRemoval] = useState<{
    owner: object;
    client: DeviceTrustClient;
  }>();
  const latestValue = useRef(trust.value);
  latestValue.current = trust.value;
  const clients = trust.value?.trusted ?? [];
  const pages = Math.max(1, Math.ceil(clients.length / 5));
  const currentPage =
    pageChoice?.owner === trust.owner ? Math.min(pageChoice.page, pages) : 1;
  const shown =
    paged && clients.length > 5
      ? clients.slice((currentPage - 1) * 5, currentPage * 5)
      : clients;
  const selected =
    removal?.owner === trust.owner &&
    trust.current() &&
    clients.some(
      (client) =>
        client.id === removal.client.id &&
        client.fingerprint === removal.client.fingerprint,
    )
      ? removal
      : undefined;
  const change = async (
    action: (api: DeviceTrustAPI) => Promise<DeviceTrustState>,
  ) => {
    if (
      !trust.current() ||
      !trust.owner.bridge ||
      mutating.current?.owner === trust.owner
    )
      return;
    const operation = { owner: trust.owner };
    mutating.current = operation;
    setBusyOwner(trust.owner);
    try {
      const value = await action(
        trust.owner.bridge as DesktopAPI & DeviceTrustAPI,
      );
      if (trust.current()) {
        if (!isState(value))
          throw new Error("Invalid device verification response.");
        trust.setValue(value);
        setPageChoice({
          owner: trust.owner,
          page: Math.min(
            currentPage,
            Math.max(1, Math.ceil(value.trusted.length / 5)),
          ),
        });
      }
    } catch (error) {
      if (trust.current()) onError(error);
    } finally {
      if (mutating.current === operation) mutating.current = undefined;
      if (trust.current()) setBusyOwner(undefined);
    }
  };
  if (!supported) return <AccountDevicesSection onError={onError} />;
  return (
    <>
      <Section joinsAbove>
        {trust.value ? (
          <Row
            label="Require trusted devices"
            description={
              <>
                Verify each new device before it can connect to Claudex on your
                computer remotely.{" "}
                <a
                  href={helpUrl("code-security")}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("Learn more")}
                </a>
              </>
            }
          >
            {surface === "web" && trust.value.requireTrustedDevices ? (
              // The web can only turn it on; each computer turns it off.
              <Unavailable reason="Turn off Require trusted devices on each computer.">
                <Toggle label="Require trusted devices" checked disabled />
              </Unavailable>
            ) : (
              <Toggle
                label="Require trusted devices"
                checked={trust.value.requireTrustedDevices}
                disabled={busy}
                onChange={(required) =>
                  void change((api) => api.setRequireTrustedDevices(required))
                }
              />
            )}
          </Row>
        ) : trust.failed ? (
          <div role="alert" className="account-profile-error">
            <span>Couldn’t load device verification.</span>
            <Button onClick={() => void trust.reload()}>Retry</Button>
          </div>
        ) : (
          <div role="status">Loading device verification…</div>
        )}
      </Section>
      <AccountDevicesSection onError={onError} />
      <Section
        title="Trusted devices"
        tightNote
        note="Devices that can control your local machine through remote sessions."
      >
        {/* With none, the heading and its note stand alone. */}
        {trust.value && trust.value.trusted.length > 0 && (
          <table
            className="account-local-devices account-trusted-devices"
            aria-label={t("Trusted devices")}
          >
            <thead>
              <tr>
                <th>{t("Device")}</th>
                <th>{t("Added")}</th>
                <th aria-label={t("Actions")} />
              </tr>
            </thead>
            <tbody>
              {shown.map((client) => (
                <tr key={client.id}>
                  <td data-no-translate>
                    {formatText("{client} on {os}", {
                      client: client.name,
                      os: client.platform,
                    })}
                  </td>
                  <td>
                    {new Date(client.addedAt).toLocaleDateString(
                      currentLocale(),
                      { year: "numeric", month: "short", day: "numeric" },
                    )}
                  </td>
                  <td>
                    <TrustedClientActions
                      client={client}
                      disabled={busy}
                      revoke={() => {
                        if (trust.current() && !busy)
                          setRemoval({ owner: trust.owner, client });
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {paged && clients.length > 5 && (
          <div className="active-sessions-pager">
            <div role="status" aria-live="polite">
              {formatText("Showing {start}–{end} of {total}", {
                start: ((currentPage - 1) * 5 + 1).toLocaleString(
                  currentLocale(),
                ),
                end: Math.min(currentPage * 5, clients.length).toLocaleString(
                  currentLocale(),
                ),
                total: clients.length.toLocaleString(currentLocale()),
              })}
            </div>
            <nav aria-label={t("Trusted devices")}>
              <button
                type="button"
                aria-label={t("Previous page")}
                disabled={currentPage <= 1 || busy}
                onClick={() =>
                  setPageChoice({ owner: trust.owner, page: currentPage - 1 })
                }
              >
                <ChevronLeft size={16} />
              </button>
              <span>
                {formatText("Page {page} of {total}", {
                  page: currentPage.toLocaleString(currentLocale()),
                  total: pages.toLocaleString(currentLocale()),
                })}
              </span>
              <button
                type="button"
                aria-label={t("Next page")}
                disabled={currentPage >= pages || busy}
                onClick={() =>
                  setPageChoice({ owner: trust.owner, page: currentPage + 1 })
                }
              >
                <ChevronRight size={16} />
              </button>
            </nav>
          </div>
        )}
        {selected && (
          <SettingsModal
            title="Remove trusted device?"
            variant="confirm"
            confirmFocus="cancel"
            onClose={() =>
              setRemoval((value) => (value === selected ? undefined : value))
            }
          >
            <p>{t("Remove this device’s trusted access to this computer.")}</p>
            <p data-no-translate>
              {formatText("{client} on {os}", {
                client: selected.client.name,
                os: selected.client.platform,
              })}
            </p>
            <div className="button-row">
              <Button
                onClick={() =>
                  setRemoval((value) =>
                    value === selected ? undefined : value,
                  )
                }
              >
                {t("Cancel")}
              </Button>
              <Button
                danger
                disabled={busy}
                onClick={() => {
                  if (
                    !trust.current() ||
                    !latestValue.current?.trusted.some(
                      (client) =>
                        client.id === selected.client.id &&
                        client.fingerprint === selected.client.fingerprint,
                    )
                  )
                    return;
                  setRemoval((value) =>
                    value === selected ? undefined : value,
                  );
                  void change((api) =>
                    api.revokeDeviceTrust(selected.client.id),
                  );
                }}
              >
                {t("Remove")}
              </Button>
            </div>
          </SettingsModal>
        )}
        {!!trust.value?.pending.length && (
          <div className="account-device-verification">
            <h4>Device verification requests</h4>
            <p>
              Compare this fingerprint with the one shown on your connecting
              device before approving.
            </p>
            {trust.value.pending.map((client) => (
              <div key={client.id}>
                <p data-no-translate>
                  {formatText("{client} on {os}", {
                    client: client.name,
                    os: client.platform,
                  })}
                </p>
                <code data-no-translate>{client.fingerprint}</code>
                <div>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void change((api) => api.rejectDeviceTrust(client.id))
                    }
                  >
                    Reject
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void change((api) =>
                        api.approveDeviceTrust(client.id, client.fingerprint),
                      )
                    }
                  >
                    Approve device
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

function TrustedClientActions({
  client,
  disabled,
  revoke,
}: {
  client: DeviceTrustClient;
  disabled: boolean;
  revoke(): void;
}) {
  const more = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuPosition>();
  const label = formatText("Actions for {device}", {
    device: formatText("{client} on {os}", {
      client: client.name,
      os: client.platform,
    }),
  });
  return (
    <>
      <button
        ref={more}
        type="button"
        className="account-device-actions"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        disabled={disabled}
        onClick={() => {
          const rect = more.current!.getBoundingClientRect();
          setMenu(
            menu
              ? undefined
              : { right: window.innerWidth - rect.right, top: rect.bottom + 4 },
          );
        }}
      >
        <MoreVertical size={16} />
      </button>
      {menu && (
        <Menu
          label={label}
          size="regular"
          width="max-content"
          position={menu}
          anchors={[more]}
          onClose={() => setMenu(undefined)}
          entries={[{ label: "Remove", danger: true, onSelect: revoke }]}
        />
      )}
    </>
  );
}
