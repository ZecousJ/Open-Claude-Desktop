import {
  useContext,
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type ClipboardDirection,
  type SimulatorAppearance,
  type SimulatorCapture,
  type SimulatorDevice,
  type SimulatorInput,
  type SimulatorKind,
  type SimulatorEditAction,
  type SimulatorElement,
  type SimulatorScreen,
} from "../../shared/simulators";
import { t } from "../i18n";
import { type MenuPosition } from "../ui/Menu";
import { ShortcutPlatform } from "../ui/Tooltip";
import { type DeviceRowActions } from "./SimulatorScreens";
import { useInspectorState } from "./SimulatorInspector";
import { FrameClock } from "./simulator-controls";
import {
  deviceDetail,
  nameParts,
  nextZoom,
  physicalZoom,
  zoomOf,
  type Press,
  type ZoomAction,
  type ZoomMode,
} from "./simulator-model";
import { type DeviceTools } from "./DeviceControls";
import { useSimulatorDeviceActions } from "./useSimulatorDeviceActions";

/** A line above the screen with an optional button (the original's notices). */
export interface Notice {
  key: string;
  text: string;
  /** The idb command, in code. */
  code?: string;
  action?: { label: string; run: () => void };
}

/** Typed characters go out together after this long without another. */
export const typingDelayMs = 120;

/**
 * The picker's face: the name in medium weight over the OS version in caption
 * size; a long name keeps its end whole.
 */
export function PickerFace({ device }: { device: SimulatorDevice }) {
  const { head, tail } = nameParts(device.name);
  const detail = deviceDetail(device);
  return (
    <span className="sim-picker-face" data-no-translate>
      <span className="sim-picker-name">
        <span className="sim-picker-head">{head}</span>
        {tail && <span className="sim-picker-tail">{tail}</span>}
      </span>
      {detail && <span className="sim-picker-detail">{detail}</span>}
    </span>
  );
}

export type ShownCapture = SimulatorCapture & {
  thumbnail: NonNullable<SimulatorCapture["thumbnail"]>;
  seq: number;
  from: DOMRect | null;
  retiring: boolean;
};

/**
 * The attached device: the Simulator menus row (Edit and Device on iOS, View),
 * the device picker (its menu ends with Detach and Shut down) with the frame
 * rate and the zoom buttons, notices, the screen (a picture redrawn about three
 * times a second; click and drag on it to tap and swipe, type to send
 * keystrokes) with a saved capture in its corner, the log drawer when open, and
 * the control bar.
 */
export function DeviceView({
  kind,
  device,
  devices,
  screen,
  notices,
  busyLabel,
  inputReady = true,
  tools,
  onSwitch,
  onInput,
  onShutdown,
  onDetach,
  rowActions,
}: {
  kind: SimulatorKind;
  device: SimulatorDevice;
  devices: readonly SimulatorDevice[];
  screen: SimulatorScreen | null;
  notices: Notice[];
  /** "Booting…" or "Attaching…" while another device is being switched to. */
  busyLabel?: string;
  /** Touch and key input work (iOS needs idb). */
  inputReady?: boolean;
  tools?: DeviceTools;
  onSwitch: (device: SimulatorDevice) => void;
  onInput: (input: SimulatorInput) => void | Promise<void>;
  onShutdown: () => void;
  onDetach: () => void;
  /** The device rows' right-click actions. */
  rowActions?: DeviceRowActions;
}) {
  const picker = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuPosition>();
  const press = useRef<Press>(undefined);
  const typed = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const noun = kind === "android" ? "emulator" : "simulator";
  const mac = useContext(ShortcutPlatform) === "darwin";
  const busy = busyLabel !== undefined;

  // Zoom: fitted to the pane until changed; back to fit for another device.
  const surface = useRef<HTMLImageElement>(null);
  const stageFrame = useRef<HTMLDivElement>(null);
  // Inspect: the screen's elements, read again every two seconds while on.
  const [inspecting, setInspecting] = useState(false);
  const [elements, setElements] = useState<SimulatorElement[]>([]);
  const [reading, setReading] = useState(false);
  const [inspectError, setInspectError] = useState<string>();
  const inspector = useInspectorState();
  useEffect(() => {
    if (!inspecting || !tools?.inspect) return;
    let live = true;
    setReading(true);
    const read = () =>
      void tools.inspect!()
        .then(
          (list) => {
            if (!live) return;
            setElements(list);
            setInspectError(undefined);
          },
          (error) =>
            live &&
            setInspectError(
              error instanceof Error && error.message
                ? error.message
                : t("Could not read the accessibility tree."),
            ),
        )
        .finally(() => live && setReading(false));
    read();
    const timer = setInterval(read, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [inspecting, device.id]);
  const [zoomState, setZoomState] = useState<{ id: string; mode: ZoomMode }>({
    id: device.id,
    mode: "fit",
  });
  const mode = zoomState.id === device.id ? zoomState.mode : "fit";
  const physical = screen ? physicalZoom(screen) : null;
  const deviceWidth = screen ? (screen.deviceWidth ?? screen.width) : 0;
  const deviceHeight = screen ? (screen.deviceHeight ?? screen.height) : 0;
  const zoom = zoomOf(mode, physical);
  // While fitted, the zoom the picture is drawn at, so the step buttons know their limits.
  const [fitted, setFitted] = useState<number | null>(null);
  const measure = () => {
    const width = surface.current?.offsetWidth ?? 0;
    return width > 0 && deviceWidth > 0 ? width / deviceWidth : null;
  };
  const shown = screen !== null;
  useLayoutEffect(() => {
    if (zoom !== null || !shown) return;
    const element = surface.current;
    if (!element) return;
    const update = () => setFitted(measure());
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [zoom, shown, deviceWidth]);
  const current = zoom ?? fitted;
  const canZoom = shown
    ? (action: ZoomAction) =>
        (current === null && (action === "in" || action === "out")) ||
        nextZoom(action, mode, current, physical) !== undefined
    : null;
  const applyZoom = (action: ZoomAction) => {
    if (!screen || busy) return;
    const next = nextZoom(action, mode, zoom ?? measure(), physical);
    if (next !== undefined) setZoomState({ id: device.id, mode: next });
  };

  // Frames: a picture that differs from the one before.
  const [clock] = useState(() => new FrameClock());
  const lastPicture = useRef<string>(undefined);
  useEffect(() => {
    clock.reset();
    lastPicture.current = undefined;
  }, [device.id]);
  useEffect(() => {
    if (!screen || screen.dataUrl === lastPicture.current) return;
    lastPicture.current = screen.dataUrl;
    clock.frame(performance.now());
  }, [screen]);

  // -- Captures --------------------------------------------------------------
  const [capturing, setCapturing] = useState(false);
  const [recordingSince, setRecordingSince] = useState<number | null>(null);
  /** The recording running, with its own device's stop. */
  const recordingOf = useRef<{
    stop: DeviceTools["stopRecording"];
    notice: DeviceTools["savedNotice"];
    report: DeviceTools["report"];
  } | null>(null);
  const [captures, setCaptures] = useState<ShownCapture[]>([]);
  const nextCapture = useRef(0);
  const [logsOpen, setLogsOpen] = useState(false);
  const [fullHeight, setFullHeight] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const toolsRef = useRef(tools);
  toolsRef.current = tools;
  const [sharedClipboard, setSharedClipboard] = useState(() => {
    try {
      return localStorage.getItem("simulator-shared-clipboard") !== "false";
    } catch {
      return true;
    }
  });
  const edit = (action: SimulatorEditAction) => {
    flush();
    const send = async () => {
      if (action === "paste" && sharedClipboard) await tools?.clipboard("send");
      await onInput({ type: "edit", action });
      if (sharedClipboard && (action === "cut" || action === "copy"))
        await tools?.clipboard("get");
    };
    void send().catch((error) => tools?.report(String(error)));
  };

  /** A saved capture: in the corner when the stage shows, else a notice with Add to chat. */
  const showCapture = (capture: SimulatorCapture) => {
    if (!alive.current || !capture.thumbnail || (logsOpen && fullHeight)) {
      toolsRef.current?.savedNotice(capture);
      return;
    }
    const from =
      capture.kind === "screenshot"
        ? (surface.current?.getBoundingClientRect() ?? null)
        : null;
    const seq = ++nextCapture.current;
    setCaptures((list) => [
      ...list.map((item) => ({ ...item, retiring: true })),
      {
        ...capture,
        thumbnail: capture.thumbnail as ShownCapture["thumbnail"],
        seq,
        from,
        retiring: false,
      },
    ]);
  };
  const saveScreenshot = () => {
    if (!tools || capturing || busy) return;
    setCapturing(true);
    tools
      .saveScreenshot()
      .then(showCapture)
      .catch(() =>
        toolsRef.current?.report("Couldn’t save the screenshot. Try again."),
      )
      .finally(() => alive.current && setCapturing(false));
  };
  const finishRecording = (report = true) => {
    const running = recordingOf.current;
    if (running === null) return Promise.resolve();
    recordingOf.current = null;
    if (alive.current) setRecordingSince(null);
    return running
      .stop()
      .then((capture) =>
        report ? showCapture(capture) : running.notice(capture),
      )
      .catch((error) =>
        running.report(
          error instanceof Error && /recording/i.test(error.message)
            ? error.message
            : "Couldn’t save the recording. Try again.",
        ),
      );
  };
  const toggleRecording = () => {
    if (!tools || capturing || busy) return;
    setCapturing(true);
    const work =
      recordingOf.current !== null
        ? finishRecording()
        : tools.startRecording().then(
            () => {
              // Stopping goes to this device even after the pane moved on.
              recordingOf.current = {
                stop: tools.stopRecording,
                notice: tools.savedNotice,
                report: tools.report,
              };
              if (alive.current) setRecordingSince(Date.now());
            },
            (error) =>
              tools.report(
                error instanceof Error && /recording/i.test(error.message)
                  ? error.message
                  : "Couldn’t start the recording. Try again.",
              ),
          );
    void work.finally(() => alive.current && setCapturing(false));
  };
  // Another device, or the pane closing, finishes a recording and saves it.
  useEffect(
    () => () => {
      if (recordingOf.current !== null) void finishRecording(false);
      setCaptures([]);
    },
    [device.id],
  );

  // -- Device menu: appearance -----------------------------------------------
  const [appearance, setAppearance] = useState<SimulatorAppearance | null>(
    null,
  );
  const readAppearance = () =>
    tools
      ?.appearance()
      .then((value) => alive.current && setAppearance(value))
      .catch(() => alive.current && setAppearance(null));
  const chooseAppearance = (value: SimulatorAppearance) => {
    if (!tools) return;
    setAppearance(value);
    tools
      .appearance(value)
      .then((now) => alive.current && setAppearance(now))
      .catch(() => {
        tools.report("Couldn’t change the appearance. Try again.");
        void readAppearance();
      });
  };
  const toggleAppearance = () => {
    if (!tools) return;
    void tools
      .appearance()
      .then((now) => chooseAppearance(now === "dark" ? "light" : "dark"))
      .catch(() => tools.report("Couldn’t change the appearance. Try again."));
  };
  // -- Device menu: the on-screen keyboard (Android) -------------------------
  /** null until read, or when the emulator can't say. */
  const [keyboard, setKeyboard] = useState<boolean | null>(null);
  const readKeyboard = () =>
    tools
      ?.softwareKeyboard()
      .then((value) => alive.current && setKeyboard(value))
      .catch(() => alive.current && setKeyboard(null));
  const chooseKeyboard = (show: boolean) => {
    if (!tools) return;
    setKeyboard(show);
    tools
      .softwareKeyboard(show)
      .then((now) => alive.current && setKeyboard(now))
      .catch(() => {
        tools.report("Couldn’t change the on-screen keyboard. Try again.");
        void readKeyboard();
      });
  };
  // -- A foldable's hinge (Android foldable emulators) -----------------------
  /** Percent open (0 closed, 100 flat), or null without a hinge. */
  const [hinge, setHinge] = useState<number | null>(null);
  const hingeFrame = useRef<number | null>(null);
  const pendingHinge = useRef<number | null>(null);
  useEffect(() => {
    setHinge(null);
    if (!tools?.hinge) return;
    let live = true;
    void tools
      .hinge()
      .then(
        (degrees) =>
          live &&
          setHinge(degrees === null ? null : Math.round((degrees / 180) * 100)),
      )
      .catch(() => undefined);
    return () => {
      live = false;
      if (hingeFrame.current !== null) cancelAnimationFrame(hingeFrame.current);
      hingeFrame.current = null;
      pendingHinge.current = null;
    };
  }, [device.id]);
  const sendHinge = (percent: number) =>
    void tools
      ?.hinge?.((percent / 100) * 180)
      .catch(() => tools.report("Couldn’t change the hinge angle. Try again."));
  const changeHinge = (percent: number) => {
    setHinge(percent);
    pendingHinge.current = percent;
    if (hingeFrame.current !== null) return;
    hingeFrame.current = requestAnimationFrame(() => {
      hingeFrame.current = null;
      if (pendingHinge.current !== null) sendHinge(pendingHinge.current);
      pendingHinge.current = null;
    });
  };
  const commitHinge = (percent: number) => {
    if (hingeFrame.current !== null) cancelAnimationFrame(hingeFrame.current);
    hingeFrame.current = null;
    pendingHinge.current = null;
    sendHinge(percent);
  };
  // -- Device menu: Slow animations ------------------------------------------
  const [slow, setSlow] = useState<boolean | null>(null);
  const readSlow = () =>
    tools
      ?.slowAnimations?.()
      .then((value) => alive.current && setSlow(value))
      .catch(() => alive.current && setSlow(null));
  const chooseSlow = (on: boolean) => {
    if (!tools?.slowAnimations) return;
    setSlow(on);
    tools
      .slowAnimations(on)
      .then((now) => {
        if (now === null) throw new Error("Slow animations did not change.");
        if (alive.current) setSlow(now);
      })
      .catch(() => {
        tools.report(
          on
            ? "Couldn’t turn on slow animations. Try again."
            : "Couldn’t turn off slow animations. Try again.",
        );
        void readSlow();
      });
  };
  const clipboard = (direction: ClipboardDirection) =>
    void tools
      ?.clipboard(direction)
      .catch((error) =>
        tools.report(error instanceof Error ? error.message : String(error)),
      );

  const flush = () => {
    clearTimeout(timer.current);
    if (!typed.current) return;
    const value = typed.current;
    typed.current = "";
    onInput({ type: "text", value });
  };
  const { deviceViewView } = useSimulatorDeviceActions({
    appearance,
    applyZoom,
    busy,
    busyLabel,
    canZoom,
    captures,
    capturing,
    changeHinge,
    chooseAppearance,
    chooseKeyboard,
    chooseSlow,
    clipboard,
    clock,
    commitHinge,
    device,
    deviceHeight,
    deviceWidth,
    devices,
    edit,
    elements,
    flush,
    fullHeight,
    hinge,
    inputReady,
    inspectError,
    inspecting,
    inspector,
    keyboard,
    kind,
    logsOpen,
    mac,
    menu,
    mode,
    notices,
    noun,
    onDetach,
    onInput,
    onShutdown,
    onSwitch,
    picker,
    press,
    readAppearance,
    readKeyboard,
    readSlow,
    reading,
    recordingSince,
    rowActions,
    saveScreenshot,
    screen,
    setCaptures,
    setElements,
    setFullHeight,
    setInspectError,
    setInspecting,
    setLogsOpen,
    setMenu,
    setSharedClipboard,
    sharedClipboard,
    slow,
    stageFrame,
    surface,
    timer,
    toggleAppearance,
    toggleRecording,
    tools,
    typed,
    zoom,
  });
  return deviceViewView;
}
