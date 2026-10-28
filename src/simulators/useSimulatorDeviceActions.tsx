import { useEffect } from "react";
import type { PointerEvent, KeyboardEvent } from "react";
import {
  gestureOf,
  zoomShortcut,
  keyPress,
  deviceDetail,
} from "./simulator-model";
import { controlShortcut, controlKeys } from "./simulator-controls";
import { typingDelayMs } from "./SimulatorDevice";
import { formatText } from "../i18n";
import type { SimulatorMenu } from "./SimulatorMenus";
import type { ZoomAction, ZoomMode, Press } from "./simulator-model";
import type { MenuEntry, MenuPosition } from "../ui/Menu";
import { deviceView } from "./DeviceViewMarkup";
import type {
  SimulatorAppearance,
  ClipboardDirection,
  SimulatorDevice,
  SimulatorElement,
  SimulatorKind,
  SimulatorInput,
  SimulatorScreen,
} from "../../shared/simulators";
import type { ShownCapture, Notice } from "./SimulatorDevice";
import type { FrameClock } from "./simulator-controls";
import type { DeviceRowActions } from "./SimulatorScreens";
import type { DeviceTools } from "./DeviceControls";
import type { InspectorSelection } from "./SimulatorInspector";

/** What useSimulatorDeviceActions needs from SimulatorDevice.tsx. */
export interface UseSimulatorDeviceActionsKit {
  appearance: SimulatorAppearance | null;
  applyZoom: (action: ZoomAction) => void;
  busy: boolean;
  busyLabel: string | undefined;
  canZoom: ((action: ZoomAction) => boolean) | null;
  captures: ShownCapture[];
  capturing: boolean;
  changeHinge: (percent: number) => void;
  chooseAppearance: (value: SimulatorAppearance) => void;
  chooseKeyboard: (show: boolean) => void;
  chooseSlow: (on: boolean) => void;
  clipboard: (direction: ClipboardDirection) => undefined;
  clock: FrameClock;
  commitHinge: (percent: number) => void;
  device: SimulatorDevice;
  deviceHeight: number;
  deviceWidth: number;
  devices: readonly SimulatorDevice[];
  edit: (
    action: "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll",
  ) => void;
  elements: SimulatorElement[];
  flush: () => void;
  fullHeight: boolean;
  hinge: number | null;
  inputReady: boolean;
  inspectError: string | undefined;
  inspecting: boolean;
  inspector: {
    hovered: SimulatorElement | undefined;
    setHovered: React.Dispatch<
      React.SetStateAction<SimulatorElement | undefined>
    >;
    selection: InspectorSelection;
    setSelection: React.Dispatch<React.SetStateAction<InspectorSelection>>;
  };
  keyboard: boolean | null;
  kind: SimulatorKind;
  logsOpen: boolean;
  mac: boolean;
  menu: MenuPosition | undefined;
  mode: ZoomMode;
  notices: Notice[];
  noun: "emulator" | "simulator";
  onDetach: () => void;
  onInput: (input: SimulatorInput) => void | Promise<void>;
  onShutdown: () => void;
  onSwitch: (device: SimulatorDevice) => void;
  picker: React.RefObject<HTMLButtonElement | null>;
  press: React.RefObject<Press | undefined>;
  readAppearance: () => Promise<false | void> | undefined;
  readKeyboard: () => Promise<false | void> | undefined;
  readSlow: () => Promise<false | void> | undefined;
  reading: boolean;
  recordingSince: number | null;
  rowActions: DeviceRowActions | undefined;
  saveScreenshot: () => void;
  screen: SimulatorScreen | null;
  setCaptures: React.Dispatch<React.SetStateAction<ShownCapture[]>>;
  setElements: React.Dispatch<React.SetStateAction<SimulatorElement[]>>;
  setFullHeight: React.Dispatch<React.SetStateAction<boolean>>;
  setInspectError: React.Dispatch<React.SetStateAction<string | undefined>>;
  setInspecting: React.Dispatch<React.SetStateAction<boolean>>;
  setLogsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setMenu: React.Dispatch<React.SetStateAction<MenuPosition | undefined>>;
  setSharedClipboard: React.Dispatch<React.SetStateAction<boolean>>;
  sharedClipboard: boolean;
  slow: boolean | null;
  stageFrame: React.RefObject<HTMLDivElement | null>;
  surface: React.RefObject<HTMLImageElement | null>;
  timer: React.RefObject<NodeJS.Timeout | undefined>;
  toggleAppearance: () => void;
  toggleRecording: () => void;
  tools: DeviceTools | undefined;
  typed: React.RefObject<string>;
  zoom: number | null;
}

export function useSimulatorDeviceActions(kit: UseSimulatorDeviceActionsKit) {
  const {
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
  } = kit;
  // Characters typed just before the device changes or the pane closes still go.
  useEffect(() => () => clearTimeout(timer.current), []);

  const down = (event: PointerEvent<HTMLImageElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    flush();
    press.current = { x: event.clientX, y: event.clientY, at: Date.now() };
  };
  const up = (event: PointerEvent<HTMLImageElement>) => {
    const start = press.current;
    press.current = undefined;
    if (!start) return;
    const box = event.currentTarget.getBoundingClientRect();
    const gesture = gestureOf(
      start,
      { x: event.clientX, y: event.clientY, at: Date.now() },
      box,
    );
    if (gesture) onInput(gesture);
  };
  const key = (event: KeyboardEvent<HTMLImageElement>) => {
    const shortcut = zoomShortcut(event, mac);
    if (shortcut) {
      event.preventDefault();
      event.stopPropagation();
      applyZoom(shortcut);
      return;
    }
    const control = controlShortcut(event, mac, kind);
    if (control) {
      event.preventDefault();
      event.stopPropagation();
      if (busy) return;
      if (control === "screenshot") saveScreenshot();
      else if (control === "back") onInput({ type: "button", name: "BACK" });
      else if (control === "rotate") onInput({ type: "rotate" });
      else if (control === "keyboard") chooseKeyboard(keyboard !== true);
      else if (control === "home") onInput({ type: "button", name: "HOME" });
      else if (control === "recents")
        onInput({ type: "button", name: "RECENTS" });
      else if (control === "lock") onInput({ type: "button", name: "LOCK" });
      else if (control === "volumeUp")
        onInput({ type: "button", name: "VOLUME_UP" });
      else if (control === "volumeDown")
        onInput({ type: "button", name: "VOLUME_DOWN" });
      else if (tools) toggleAppearance();
      return;
    }
    if (
      kind === "ios" &&
      (mac ? event.metaKey : event.ctrlKey) &&
      !event.altKey
    ) {
      const action = (
        {
          z: event.shiftKey ? "redo" : "undo",
          x: "cut",
          c: "copy",
          v: "paste",
          a: "selectAll",
        } as const
      )[event.key.toLowerCase() as "z" | "x" | "c" | "v" | "a"];
      if (action) {
        event.preventDefault();
        event.stopPropagation();
        if (!busy) edit(action);
        return;
      }
    }
    const pressed = keyPress(event);
    if (!pressed) return;
    event.preventDefault();
    if ("text" in pressed) {
      typed.current += pressed.text;
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, typingDelayMs);
      return;
    }
    flush();
    onInput({ type: "key", name: pressed.key });
  };

  const detail = deviceDetail(device);
  const pickerLabel = detail
    ? formatText("{name}, {detail}", { name: device.name, detail })
    : device.name;

  // -- Simulator menus -------------------------------------------------------
  const appearanceName = { light: "Light", dark: "Dark" } as const;
  const menus: SimulatorMenu[] = [];
  if (tools && kind === "ios") {
    menus.push({
      key: "edit",
      label: "Edit",
      entries: [
        {
          label: "Undo",
          shortcut: ["mod", "Z"],
          onSelect: () => edit("undo"),
        },
        {
          label: "Redo",
          shortcut: ["shift", "mod", "Z"],
          onSelect: () => edit("redo"),
        },
        { separator: true },
        {
          label: "Cut",
          shortcut: ["mod", "X"],
          onSelect: () => edit("cut"),
        },
        {
          label: "Copy",
          shortcut: ["mod", "C"],
          onSelect: () => edit("copy"),
        },
        {
          label: "Paste",
          shortcut: ["mod", "V"],
          onSelect: () => edit("paste"),
        },
        {
          label: "Delete",
          disabled: !inputReady,
          onSelect: () => onInput({ type: "key", name: "BACKSPACE" }),
        },
        {
          label: "Select all",
          shortcut: ["mod", "A"],
          onSelect: () => edit("selectAll"),
        },
        { separator: true },
        {
          label: "Use Mac clipboard when pasting",
          checked: sharedClipboard,
          onSelect: () => {
            setSharedClipboard(!sharedClipboard);
            try {
              localStorage.setItem(
                "simulator-shared-clipboard",
                String(!sharedClipboard),
              );
            } catch {}
          },
        },
        { label: "Get clipboard", onSelect: () => clipboard("get") },
        { label: "Send clipboard", onSelect: () => clipboard("send") },
      ],
    });
    menus.push({
      key: "device",
      label: "Device",
      onOpen: () => {
        void readAppearance();
        void readKeyboard();
        void readSlow();
      },
      entries: [
        {
          label: "Appearance",
          value: appearance ? appearanceName[appearance] : undefined,
          submenu: [
            {
              label: "Light",
              checked: appearance === "light",
              onSelect: () => chooseAppearance("light"),
            },
            {
              label: "Dark",
              checked: appearance === "dark",
              onSelect: () => chooseAppearance("dark"),
            },
            { separator: true },
            {
              label: "Toggle",
              shortcut: controlKeys.appearance,
              onSelect: toggleAppearance,
            },
          ],
        },
        {
          label: "Keyboard",
          submenu: [
            {
              label: "Show on-screen keyboard",
              shortcut: ["mod", "K"],
              checked: keyboard === true,
              onSelect: () => chooseKeyboard(keyboard !== true),
            },
          ],
        },
        ...(tools.slowAnimations
          ? [
              { separator: true } as const,
              {
                label: "Slow animations",
                checked: slow === true,
                onSelect: () => chooseSlow(slow !== true),
              },
            ]
          : []),
      ],
    });
  }
  if (tools && kind === "android")
    menus.push({
      key: "device",
      label: "Device",
      onOpen: () => {
        void readKeyboard();
        void readSlow();
      },
      entries: [
        {
          label: "Show on-screen keyboard",
          checked: keyboard === true,
          disabled: keyboard === null,
          onSelect: () => chooseKeyboard(keyboard !== true),
        },
        ...(tools.slowAnimations
          ? [
              { separator: true } as const,
              {
                label: "Slow animations",
                checked: slow === true,
                onSelect: () => chooseSlow(slow !== true),
              },
            ]
          : []),
      ],
    });
  const zoomItem = (
    action: ZoomAction,
    label: string,
    keys: string[],
  ): MenuEntry => ({
    label,
    shortcut: keys,
    disabled: !canZoom?.(action),
    onSelect: () => applyZoom(action),
  });
  menus.push({
    key: "view",
    label: "View",
    entries: [
      zoomItem("in", "Zoom in", ["mod", "+"]),
      zoomItem("out", "Zoom out", ["mod", "-"]),
      zoomItem("fit", "Zoom to fit", ["mod", "0"]),
      zoomItem("physical", "Physical size", ["mod", "1"]),
    ],
  });

  const stageHidden = logsOpen && fullHeight;
  const closeInspector = () => {
    setInspecting(false);
    inspector.setSelection({ stack: [], index: 0 });
    inspector.setHovered(undefined);
    surface.current?.focus({ preventScroll: true });
  };
  const deviceViewView = deviceView({
    applyZoom,
    busy,
    busyLabel,
    canZoom,
    captures,
    capturing,
    changeHinge,
    clock,
    closeInspector,
    commitHinge,
    device,
    deviceHeight,
    deviceWidth,
    devices,
    down,
    elements,
    flush,
    fullHeight,
    hinge,
    inspectError,
    inspecting,
    inspector,
    key,
    kind,
    logsOpen,
    menu,
    menus,
    mode,
    notices,
    noun,
    onDetach,
    onInput,
    onShutdown,
    onSwitch,
    picker,
    pickerLabel,
    press,
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
    stageFrame,
    stageHidden,
    surface,
    toggleRecording,
    tools,
    up,
    zoom,
  });
  return { deviceViewView } as const;
}
