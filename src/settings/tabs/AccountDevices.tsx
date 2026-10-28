import { useRef, useState } from "react";
import type { DeviceInfo } from "../../../shared/remote-devices";
import { currentLocale, formatText, t, tc } from "../../i18n";
import { RelativeTime } from "../../ui/RelativeTime";
import { Skeleton } from "../../ui/Skeleton";
import { MoreVertical } from "../../ui/glyphs";
import { Menu, type MenuPosition } from "../../ui/Menu";
import { Button, Section } from "../controls";
import { useAccountRead } from "../useAccountRead";
import type { TabProps } from "../context";
import "./account-devices.css";

const isDevices = (value: unknown): value is DeviceInfo[] =>
  Array.isArray(value) &&
  value.every(
    (device) =>
      !!device &&
      typeof device === "object" &&
      typeof device.id === "string" &&
      typeof device.name === "string" &&
      typeof device.platform === "string",
  );

/** Actual task-host inventory, independent of authenticated client sessions. */
export function AccountDevicesSection({ onError }: Pick<TabProps, "onError">) {
  const devices = useAccountRead(
    (bridge) => bridge.listCoworkDevices(),
    isDevices,
    onError,
    true,
  );
  const [details, setDetails] = useState<DeviceInfo>();
  const date = (value: string | undefined) => {
    const at = value ? new Date(value) : undefined;
    return at && Number.isFinite(at.getTime())
      ? at.toLocaleDateString(currentLocale(), {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : "—";
  };
  const platform = (value: string) =>
    value === "darwin"
      ? "macOS"
      : value === "win32"
        ? "Windows"
        : value === "linux"
          ? "Linux"
          : value;
  return (
    <Section
      title="Local devices"
      tightNote
      note="Computers that can run tasks with access to local files, computer use, browser use, and local MCPs."
    >
      <div className="account-devices-scroll">
        <table
          className="account-local-devices"
          aria-label={t("Local devices")}
        >
          <thead>
            <tr>
              <th>Name</th>
              <th>OS</th>
              <th>Added</th>
              <th>{tc("device", "Last seen")}</th>
              <th aria-label={t("Actions")} />
            </tr>
          </thead>
          <tbody aria-busy={devices.loading || undefined}>
            {devices.loading ? (
              [0, 1].map((row) => (
                <tr key={row} aria-hidden="true">
                  {[0, 1, 2, 3, 4].map((column) => (
                    <td key={column}>
                      <Skeleton width={column === 0 ? 120 : 80} height={14} />
                    </td>
                  ))}
                </tr>
              ))
            ) : devices.failed ? (
              <tr>
                <td colSpan={5}>
                  <div role="alert" className="account-profile-error">
                    <span>Couldn’t load your computers</span>
                    <Button onClick={() => void devices.reload()}>Retry</Button>
                  </div>
                </td>
              </tr>
            ) : devices.value?.length ? (
              devices.value.map((device) => (
                <tr key={device.id}>
                  <td data-no-translate>{device.name}</td>
                  <td data-no-translate>{platform(device.platform)}</td>
                  <td>{date(device.addedAt)}</td>
                  <td>
                    {device.lastSeenAt &&
                    Number.isFinite(new Date(device.lastSeenAt).getTime()) ? (
                      <RelativeTime
                        createdAt={new Date(device.lastSeenAt).getTime()}
                        relativeFormat="narrow"
                      />
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <DeviceActions
                      name={device.name}
                      onDetails={() => setDetails(device)}
                    />
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5}>No devices found</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {details && (
        <div className="account-device-details" role="status">
          <span data-no-translate>
            {details.name} · {platform(details.platform)} · {details.version}
          </span>
          <Button onClick={() => setDetails(undefined)}>Close</Button>
        </div>
      )}
    </Section>
  );
}

/** The captured menu contents are unobserved. Details reads the real record;
 * destructive host removal is deliberately not claimed as official behavior. */
function DeviceActions({
  name,
  onDetails,
}: {
  name: string;
  onDetails(): void;
}) {
  const more = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuPosition>();
  const label = formatText("Actions for {device}", { device: name });
  return (
    <>
      <button
        ref={more}
        type="button"
        className="account-device-actions"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
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
          width={180}
          position={menu}
          anchors={[more]}
          onClose={() => setMenu(undefined)}
          entries={[{ label: "Device details", onSelect: onDetails }]}
        />
      )}
    </>
  );
}
