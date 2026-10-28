import { formatText } from "../i18n";
import {
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { X } from "../ui/glyphs";
import type { Attachment, Conversation } from "../../shared/types";
import {
  setupReady,
  simulatorKindLabel,
  simulatorNoun,
  type AndroidSetupStatus,
  type IosSetupStatus,
  type SimulatorAnnotateCapture,
  type SimulatorDevice,
  type SimulatorKind,
  type SimulatorScreen,
  type SimulatorsState,
} from "../../shared/simulators";
import type { SimulatorsAPI } from "../../shared/simulators-api";
import { AppContext } from "../app/AppContext";
import { api } from "../desktop-api";
import { IconButton } from "../ui/Controls";
import { lazyPiece } from "../ui/lazy-piece";
import { showToast } from "../ui/toast-store";
import { DeviceView } from "./SimulatorDevice";
import {
  AttachScreen,
  Checking,
  PermissionScreen,
  RenameDeviceDialog,
  SetupScreen,
  Unavailable,
  Working,
} from "./SimulatorScreens";
import type { SimulatorElement } from "../../shared/simulators";
import { useSimulatorPanelState } from "./useSimulatorPanelState";

/** The element's part of a PNG (with a little room around it), as PNG bytes. */
export async function cropElement(
  dataUrl: string,
  frame: SimulatorElement["frame"],
): Promise<Uint8Array | undefined> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const pad = 8;
  const x = Math.max(0, Math.floor(frame.x * image.naturalWidth) - pad);
  const y = Math.max(0, Math.floor(frame.y * image.naturalHeight) - pad);
  const width = Math.min(
    image.naturalWidth - x,
    Math.ceil(frame.width * image.naturalWidth) + pad * 2,
  );
  const height = Math.min(
    image.naturalHeight - y,
    Math.ceil(frame.height * image.naturalHeight) + pad * 2,
  );
  if (width <= 0 || height <= 0) return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas
    .getContext("2d")
    ?.drawImage(image, x, y, width, height, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  return blob ? new Uint8Array(await blob.arrayBuffer()) : undefined;
}
import { setupSteps, type Failure } from "./simulator-model";
import "./simulator-panel.css";

/** What the pane asks of the main process (the window's `desktop` bridge by default). */
export type SimulatorBridge = Pick<
  SimulatorsAPI,
  | "simulatorsState"
  | "simulatorSetup"
  | "simulatorDevices"
  | "simulatorBoot"
  | "simulatorShutdown"
  | "simulatorRestart"
  | "simulatorRename"
  | "simulatorInspect"
  | "simulatorScreen"
  | "simulatorInput"
  | "simulatorAccess"
  | "simulatorAllow"
  | "simulatorOpen"
  | "simulatorSaveScreenshot"
  | "simulatorStartRecording"
  | "simulatorStopRecording"
  | "simulatorCaptureAction"
  | "simulatorAttachCapture"
  | "simulatorAppearance"
  | "simulatorSoftwareKeyboard"
  | "simulatorSlowAnimations"
  | "simulatorHinge"
  | "simulatorClipboard"
  | "simulatorLogs"
  | "simulatorLogsStop"
> & {
  simulatorSetSubscribed?: SimulatorsAPI["simulatorSetSubscribed"];
  onEvent?: (
    listener: (event: import("../../shared/types").AppEvent) => void,
  ) => () => void;
  copyText?: (text: string) => Promise<unknown>;
  /** Annotate: the screen as a full-size PNG (absent: no Annotate). */
  simulatorCaptureScreenshot?: SimulatorsAPI["simulatorCaptureScreenshot"];
  /** Keeps the annotated PNG as an attachment (the composer's paste path). */
  addAttachmentData?: (name: string, data: Uint8Array) => Promise<Attachment>;
};

/** The annotation editor loads when Annotate is first used. */
const AnnotateImage = lazyPiece(() => import("./AnnotateImage"));

export const switchKey = {
  ios: "iosSimulatorAccess",
  android: "androidEmulatorAccess",
} as const;

/** The device each conversation's pane showed, so a card that re-mounts picks it up again. */
export const attachedIds = new Map<string, string>();

const setupPollMs = 2500;
const devicesPollMs = 3000;

export const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * The iOS Simulator and Android Emulator panes: the setup steps while Xcode or
 * the Android SDK isn't ready, then "Attach a simulator" with the devices that
 * are booted or would boot, the one-time "Let Claudex use this simulator?" and
 * the device itself. Claudex draws the device as a picture of its screen taken
 * about three times a second (not the original's live stream) and sends clicks,
 * drags and keys to it.
 */
export function SimulatorPanel({
  kind,
  conversation,
  onClose,
  onError,
  bridge: given,
}: {
  kind: SimulatorKind;
  conversation: Conversation;
  onClose: () => void;
  onError: (error: unknown) => void;
  bridge?: SimulatorBridge;
}) {
  const bridge: SimulatorBridge = given ?? api;
  const app = useContext(AppContext);
  const remembered = `${conversation.id}:${kind}`;
  const [state, setState] = useState<SimulatorsState>();
  const [setup, setSetup] = useState<IosSetupStatus | AndroidSetupStatus>();
  // A failed setup check says why instead of spinning without end.
  const [checkProblem, setCheckProblem] = useState<string>();
  const [devices, setDevices] = useState<SimulatorDevice[] | null>(null);
  const [attachedId, setAttachedId] = useState(() =>
    attachedIds.get(remembered),
  );
  const [busy, setBusy] = useState<
    "attach" | "boot" | "shutdown" | "restart"
  >();
  const [failure, setFailure] = useState<Failure>();
  const [access, setAccess] = useState<boolean>();
  const [asking, setAsking] = useState(false);
  const [screen, setScreen] = useState<SimulatorScreen | null>(null);
  const [problem, setProblem] = useState<string>();
  const [annotating, setAnnotating] = useState<SimulatorAnnotateCapture>();
  // The attached simulator was shut down.
  const [wasShutDown, setWasShutDown] = useState(false);
  const label = simulatorKindLabel[kind];
  const noun = simulatorNoun[kind];
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Which kinds this computer runs.
  useEffect(() => {
    bridge
      .simulatorsState()
      .then((next) => alive.current && setState(next))
      .catch(onError);
  }, [bridge]);
  const supported = state ? state[kind].supported : undefined;

  // The setup check, until it passes.
  const ready = setup !== undefined && setupReady(kind, setup);
  useEffect(() => {
    if (supported !== true || ready) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const next = await bridge.simulatorSetup(kind);
        if (!next) throw new Error("The setup check didn’t answer.");
        if (alive.current) {
          setSetup(next);
          setCheckProblem(undefined);
        }
        if (alive.current && !setupReady(kind, next))
          timer = setTimeout(check, setupPollMs);
      } catch (error) {
        if (alive.current) {
          setCheckProblem(
            formatText("Couldn’t check the setup: {reason}", {
              reason: error instanceof Error ? error.message : String(error),
            }),
          );
          timer = setTimeout(check, setupPollMs * 2);
        }
        console.error(error);
      }
    };
    void check();
    return () => clearTimeout(timer);
  }, [bridge, kind, supported, ready]);

  // idb is looked for again while it is missing, so installing it shows at once.
  const waitingForIdb =
    ready && kind === "ios" && (setup as IosSetupStatus).input === false;
  useEffect(() => {
    if (!waitingForIdb) return;
    const timer = setInterval(() => {
      bridge
        .simulatorSetup(kind)
        .then((next) => alive.current && setSetup(next))
        .catch(() => undefined);
    }, 5000);
    return () => clearInterval(timer);
  }, [bridge, kind, waitingForIdb]);

  // The devices, while the pane can list them.
  const refreshDevices = useCallback(async () => {
    const list = await bridge.simulatorDevices(kind);
    if (alive.current) setDevices(list);
    return list;
  }, [bridge, kind]);
  useEffect(() => {
    if (!ready || busy) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        await refreshDevices();
        setFailure((current) =>
          current?.title === "Couldn’t load devices" ? undefined : current,
        );
      } catch (error) {
        if (alive.current)
          setFailure({
            title: "Couldn’t load devices",
            detail: message(error),
          });
      }
      if (alive.current) timer = setTimeout(poll, devicesPollMs);
    };
    void poll();
    return () => clearTimeout(timer);
  }, [ready, busy, refreshDevices]);

  const device = devices?.find(
    (item) =>
      item.state === "booted" &&
      (item.id === attachedId || (attachedId && item.avd === attachedId)),
  );
  // The attached device went away (shut down elsewhere): back to the list,
  // which says so when it was a simulator that is now off.
  useEffect(() => {
    if (devices && attachedId && !busy && !asking && !device) {
      const gone = devices.find(
        (item) => item.id === attachedId || item.avd === attachedId,
      );
      if (
        kind === "ios" &&
        (gone?.state === "shutdown" || gone?.state === "shutting-down")
      )
        setWasShutDown(true);
      setAttachedId(undefined);
      attachedIds.delete(remembered);
    }
  }, [devices, attachedId, busy, asking, device, remembered, kind]);
  const {
    open,
    allow,
    notices,
    tools,
    attach,
    send,
    shutdown,
    detach,
    rowActions,
    renaming,
    rename,
    setRenaming,
    addAnnotated,
  } = useSimulatorPanelState({
    access,
    alive,
    annotating,
    app,
    bridge,
    busy,
    conversation,
    device,
    failure,
    kind,
    label,
    noun,
    onError,
    problem,
    refreshDevices,
    remembered,
    setAccess,
    setAnnotating,
    setAsking,
    setAttachedId,
    setBusy,
    setFailure,
    setProblem,
    setScreen,
    setWasShutDown,
    setup,
    state,
  });

  let body;
  if (supported === false)
    body = (
      <Unavailable
        text={
          kind === "ios"
            ? "The iOS Simulator requires macOS."
            : "The Android Emulator is not supported on this platform."
        }
      />
    );
  else if (supported === undefined || !setup)
    body = <Checking kind={kind} problem={checkProblem} />;
  else if (!ready)
    body = (
      <SetupScreen
        steps={setupSteps(kind, setup)}
        onOpen={open}
        onCopy={(text) => void bridge.copyText?.(text)}
      />
    );
  else if (busy === "shutdown" || busy === "restart")
    body = (
      <Working
        text={
          busy === "restart"
            ? kind === "android"
              ? "Restarting the emulator…"
              : "Restarting the simulator…"
            : kind === "android"
              ? "Shutting down the emulator…"
              : "Shutting down the simulator…"
        }
      />
    );
  else if (device && asking && busy !== "boot")
    body = (
      <PermissionScreen
        kind={kind}
        device={device}
        busy={false}
        onCancel={() => setAsking(false)}
        onContinue={() => void allow(device)}
      />
    );
  else if (device)
    body = (
      <DeviceView
        kind={kind}
        device={device}
        devices={devices ?? []}
        screen={screen}
        notices={notices}
        busyLabel={
          busy === "boot"
            ? "Booting…"
            : busy === "attach"
              ? "Attaching…"
              : undefined
        }
        inputReady={
          kind === "android" || (setup as IosSetupStatus).input !== false
        }
        tools={tools}
        onSwitch={(next) => void attach(next)}
        onInput={send}
        onShutdown={() => void shutdown()}
        onDetach={detach}
        rowActions={rowActions}
      />
    );
  else
    body = (
      <AttachScreen
        kind={kind}
        devices={devices}
        busy={busy}
        failure={failure}
        notice={
          wasShutDown && !failure
            ? "This simulator was shut down. Attach it again to start it."
            : undefined
        }
        onAttach={(next) => void attach(next)}
        rowActions={rowActions}
      />
    );

  return (
    <aside
      className={`work-panel simulator-panel ${kind}-${kind === "ios" ? "simulator" : "emulator"}-panel`}
      aria-label={label}
    >
      <header>
        <strong>{label}</strong>
        <IconButton label="Close" className="sim-icon-button" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </header>
      {body}
      {renaming && (
        <RenameDeviceDialog
          initialName={renaming.name}
          onRename={(name) => void rename(renaming, name)}
          onClose={() => setRenaming(undefined)}
        />
      )}
      {annotating && (
        <Suspense fallback={null}>
          <AnnotateImage
            capture={annotating}
            onAdd={addAnnotated}
            onError={(text: string) => void showToast(text)}
            onClose={() => setAnnotating(undefined)}
          />
        </Suspense>
      )}
    </aside>
  );
}
