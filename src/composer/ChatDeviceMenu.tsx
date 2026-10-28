import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChatDeviceDirectory } from "../../shared/chat-devices-api";
import { chatDeviceUnavailable } from "../../shared/chat-devices-api";
import type { DeviceInfo } from "../../shared/remote-devices";
import { AppContext } from "../app/AppContext";
import { AppIcon } from "../ui/app-icon";
import { t } from "../i18n";
import { preference } from "../../shared/settings-extras";
import { useAddMenuResource } from "./useAddMenuResource";
import { draftChatDevice, electDraftChatDevice } from "./chat-device-selection";

type Read = {
  directory?: ChatDeviceDirectory;
  devices: DeviceInfo[];
  error?: string;
};
const read = async (bridge: Window["desktop"]): Promise<Read[]> => {
  try {
    const directory = await bridge.chatDevices();
    if (
      directory?.version !== 1 ||
      directory.organizationId !== null ||
      !directory.accountScope ||
      !Array.isArray(directory.devices)
    )
      throw new Error(chatDeviceUnavailable);
    return [{ directory, devices: directory.devices }];
  } catch (error) {
    const devices = await bridge.listCoworkDevices();
    if (!Array.isArray(devices)) throw new Error(chatDeviceUnavailable);
    return [
      {
        devices,
        error: error instanceof Error ? error.message : chatDeviceUnavailable,
      },
    ];
  }
};
export function useChatDevices(eligible: boolean) {
  const app = useContext(AppContext);
  const resource = useAddMenuResource(
    eligible ? read : readNone,
    app?.accountId ?? "local",
  );
  const bridge = typeof window === "undefined" ? undefined : window.desktop;
  const cached = useRef<
    { account: string; bridge: typeof bridge; value: Read } | undefined
  >(undefined);
  if (resource.status === "loaded" && resource.rows[0])
    cached.current = {
      account: app?.accountId ?? "local",
      bridge,
      value: resource.rows[0],
    };
  useEffect(() => {
    if (!eligible || !bridge) return;
    return bridge.onEvent?.((event) => {
      if (
        window.desktop === bridge &&
        (event.type === "devices-changed" || event.type === "service-changed")
      )
        resource.reload();
    });
  }, [bridge, eligible, resource.reload]);
  const previous = cached.current;
  const value =
    resource.rows[0] ??
    (resource.status === "pending" &&
    previous?.account === (app?.accountId ?? "local") &&
    previous.bridge === bridge
      ? previous.value
      : undefined);
  return { ...resource, value: eligible ? value : undefined };
}
const readNone = async () => [];
const seen = (at?: string) => {
  if (!at || !Number.isFinite(Date.parse(at))) return undefined;
  const days = Math.floor((Date.now() - Date.parse(at)) / 86400000);
  return new Intl.RelativeTimeFormat(undefined, {
    numeric: "auto",
    style: "short",
  }).format(-Math.max(days, 0), "day");
};
export function ChatDeviceMenu({
  value,
  processing,
  onSettings,
  onError,
}: {
  value: Read;
  processing: boolean;
  onSettings(): void;
  onError(message: string): void;
}) {
  const app = useContext(AppContext);
  const bridge = window.desktop;
  const account = app?.accountId;
  const owner = app?.controllerScope ?? app?.currentController ?? app;
  const controller = app?.currentController;
  const activeId = app?.activeId;
  const draftSession = activeId ? undefined : app?.draftSession;
  // The menu can remain mounted while its controller or session changes.
  // A request only disables the owner that started it.
  const scope = useMemo(
    () => ({}),
    [account, owner, controller, activeId, draftSession, bridge],
  );
  type Pending = { scope: typeof scope };
  const [pendingRequest, setPendingRequest] = useState<Pending>();
  const pendingOperation = useRef<Pending>(undefined);
  const mounted = useRef<typeof scope>(undefined);
  useLayoutEffect(() => {
    mounted.current = scope;
    return () => {
      if (mounted.current === scope) mounted.current = undefined;
    };
  }, [scope]);
  const pending = pendingRequest?.scope === scope;
  const [, refresh] = useState(0);
  const latest = useRef({ app, bridge, processing, scope });
  latest.current = { app, bridge, processing, scope };
  const actual = app?.active?.chatDeviceBinding;
  const selected =
    actual?.deviceId ??
    (app?.active?.linkedToComputer
      ? app.active.linkedComputerId
      : app
        ? draftChatDevice(app)?.deviceId
        : undefined);
  const permission = app
    ? preference(app.snapshot.settings, "taskPermission")
    : "default";
  const fixed = app?.active?.linkedToComputer && !actual;
  const reason = fixed
    ? "This Cowork task is bound to its owning computer and cannot be moved with Chat Devices."
    : permission === "bypass"
      ? "This computer doesn't support the selected permission mode."
      : value.error;
  const choose = async (device: DeviceInfo) => {
    if (
      !app ||
      reason ||
      pendingOperation.current?.scope === scope ||
      latest.current.processing ||
      window.desktop !== bridge ||
      latest.current.app !== app
    )
      return;
    const current = () => {
      if (
        mounted.current !== scope ||
        latest.current.scope !== scope ||
        window.desktop !== bridge ||
        app.currentController !== controller
      )
        return false;
      const live = controller ? controller.current : latest.current.app;
      return Boolean(
        live &&
        live.accountId === account &&
        (live.controllerScope ?? live.currentController ?? live) === owner &&
        live.activeId === activeId &&
        (activeId || live.draftSession === draftSession),
      );
    };
    if (!current() || !value.directory) return;
    const deviceId = selected === device.id ? null : device.id;
    if (!app.active) {
      electDraftChatDevice(app, value.directory, deviceId);
      refresh((value) => value + 1);
      return;
    }
    const operation = { scope };
    pendingOperation.current = operation;
    setPendingRequest(operation);
    try {
      const conversation = await bridge.setChatDevice({
        version: 1,
        accountScope: value.directory.accountScope,
        organizationId: null,
        conversationId: app.active.id,
        expectedBindingRevision:
          actual?.revision ?? app.active.chatDeviceRevision ?? 0,
        deviceId,
        taskPermission: permission as "default" | "auto",
      });
      if (current()) app.upsert(conversation);
    } catch (error) {
      if (current())
        onError(error instanceof Error ? error.message : String(error));
    } finally {
      // An older request can settle after the next owner starts its own.
      if (pendingOperation.current === operation)
        pendingOperation.current = undefined;
      if (mounted.current === scope)
        setPendingRequest((pending) =>
          pending === operation ? undefined : pending,
        );
    }
  };
  return (
    <>
      <div className="composer-device-heading">{t("Run tasks on")}</div>
      {value.devices.map((device) => {
        const unavailable =
          reason ??
          (device.chatBindingVersion !== 1
            ? "This computer doesn't support Chat device binding version 1."
            : !device.chatModes?.includes(app?.mode as "chat" | "cowork")
              ? "This computer doesn't support this session's execution mode."
              : !device.chatPermissionModes?.includes(
                    permission as "default" | "auto",
                  )
                ? "This computer doesn't support the selected permission mode."
                : undefined);
        const subtitle = seen(device.lastSeenAt);
        return (
          <button
            key={device.id}
            role="menuitemcheckbox"
            className="composer-device-row"
            aria-checked={selected === device.id}
            disabled={processing || pending || Boolean(unavailable)}
            title={
              unavailable
                ? t(unavailable)
                : device.addedAt
                  ? `${t("Added")} ${new Date(device.addedAt).toLocaleDateString()}`
                  : undefined
            }
            onClick={() => void choose(device)}
          >
            <AppIcon name="Computer" size={20} />
            <span className="composer-device-name">
              <span data-no-translate>{device.name}</span>
              {subtitle && <small>{subtitle}</small>}
            </span>
            <span className="composer-device-trailing">
              {device.id === value.directory?.defaultDeviceId && (
                <small>{t("Default")}</small>
              )}
              <span className="composer-device-check" aria-hidden="true">
                {selected === device.id && <AppIcon name="Check" size={20} />}
              </span>
            </span>
          </button>
        );
      })}
      {reason && (
        <p className="composer-device-error" role="note">
          {t(reason)}
        </p>
      )}
      {app?.active?.chatDeviceError && (
        <p className="composer-device-error" role="status">
          {t(app.active.chatDeviceError)}
        </p>
      )}
      <div className="composer-add-separator" role="separator" />
      <button role="menuitem" onClick={onSettings}>
        <AppIcon name="Settings" size={20} />
        <span>{t("Manage computers")}</span>
      </button>
    </>
  );
}
