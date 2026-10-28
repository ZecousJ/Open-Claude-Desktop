import { MenuRow } from "./SimulatorMenus";
import { WithTooltip } from "../ui/Tooltip";
import { below, deviceEntries } from "./SimulatorScreens";
import { Spinner } from "../ui/Spinner";
import { PickerFace } from "./SimulatorDevice";
import { FrameRate, deviceMenuFooter } from "./DeviceControls";
import { ChevronDown } from "../ui/glyphs";
import { ZoomControls } from "./SimulatorZoom";
import { CaptureThumbnail } from "./CaptureThumbnail";
import { InspectorLayer, InspectorPanel } from "./SimulatorInspector";
import { LogsDrawer } from "./SimulatorLogs";
import { ControlBar } from "./SimulatorControlBar";
import { canRecord } from "../../shared/simulators";
import { Menu } from "../ui/Menu";
import type { ZoomAction, ZoomMode, Press } from "./simulator-model";
import type { ShownCapture, Notice } from "./SimulatorDevice";
import type { DeviceTools } from "./DeviceControls";
import type { FrameClock } from "./simulator-controls";
import type {
  SimulatorDevice,
  SimulatorElement,
  SimulatorKind,
  SimulatorInput,
  SimulatorScreen,
} from "../../shared/simulators";
import type { MenuPosition } from "../ui/Menu";
import type { SimulatorMenu } from "./SimulatorMenus";
import type { DeviceRowActions } from "./SimulatorScreens";
import type { InspectorSelection } from "./SimulatorInspector";

/** What deviceView needs from SimulatorDevice.tsx. */
export interface DeviceViewKit {
  applyZoom: (action: ZoomAction) => void;
  busy: boolean;
  busyLabel: string | undefined;
  canZoom: ((action: ZoomAction) => boolean) | null;
  captures: ShownCapture[];
  capturing: boolean;
  changeHinge: (percent: number) => void;
  clock: FrameClock;
  closeInspector: () => void;
  commitHinge: (percent: number) => void;
  device: SimulatorDevice;
  deviceHeight: number;
  deviceWidth: number;
  devices: readonly SimulatorDevice[];
  down: (event: React.PointerEvent<HTMLImageElement>) => void;
  elements: SimulatorElement[];
  flush: () => void;
  fullHeight: boolean;
  hinge: number | null;
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
  key: (event: React.KeyboardEvent<HTMLImageElement>) => void;
  kind: SimulatorKind;
  logsOpen: boolean;
  menu: MenuPosition | undefined;
  menus: SimulatorMenu[];
  mode: ZoomMode;
  notices: Notice[];
  noun: "emulator" | "simulator";
  onDetach: () => void;
  onInput: (input: SimulatorInput) => void | Promise<void>;
  onShutdown: () => void;
  onSwitch: (device: SimulatorDevice) => void;
  picker: React.RefObject<HTMLButtonElement | null>;
  pickerLabel: string;
  press: React.RefObject<Press | undefined>;
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
  stageFrame: React.RefObject<HTMLDivElement | null>;
  stageHidden: boolean;
  surface: React.RefObject<HTMLImageElement | null>;
  toggleRecording: () => void;
  tools: DeviceTools | undefined;
  up: (event: React.PointerEvent<HTMLImageElement>) => void;
  zoom: number | null;
}

export function deviceView(kit: DeviceViewKit) {
  const {
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
  } = kit;
  const deviceViewView = (
    <div className="sim-device">
      <MenuRow menus={menus} disabled={busy} />
      <div className="sim-bar">
        <WithTooltip label={pickerLabel}>
          {(tooltip) => (
            <button
              {...tooltip}
              ref={picker}
              type="button"
              className="sim-picker"
              aria-label={
                kind === "android" ? "Choose emulator" : "Choose simulator"
              }
              aria-haspopup="menu"
              aria-expanded={menu !== undefined}
              aria-disabled={busy || undefined}
              onClick={() => {
                if (busy) return;
                setMenu(menu ? undefined : below(picker.current));
              }}
            >
              {busyLabel ? (
                <span className="sim-picker-busy">
                  <Spinner
                    inheritColor
                    className="spin"
                    size={14}
                    aria-hidden="true"
                  />
                  {busyLabel}
                </span>
              ) : (
                <PickerFace device={device} />
              )}
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          )}
        </WithTooltip>
        {busyLabel && (
          <span role="status" className="sr-only">
            {busyLabel}
          </span>
        )}
        <span className="sim-bar-spring">
          <FrameRate clock={clock} />
        </span>
        <ZoomControls
          canZoom={busy ? null : canZoom}
          mode={typeof mode === "number" ? "step" : mode}
          onZoom={applyZoom}
        />
      </div>
      {notices.map((notice) => (
        <div key={notice.key} className="sim-notice" role="status">
          <span>
            {notice.text}
            {notice.code && (
              <>
                {" "}
                <code data-no-translate>{notice.code}</code>
              </>
            )}
          </span>
          {notice.action && (
            <button type="button" onClick={notice.action.run}>
              {notice.action.label}
            </button>
          )}
        </div>
      ))}
      <div className="sim-stage-row" hidden={stageHidden}>
        <div ref={stageFrame} className="sim-stage-frame">
          <div className={`sim-stage ${zoom === null ? "" : "zoomed"}`}>
            {screen ? (
              <img
                ref={surface}
                className={`sim-screen ${kind}`}
                style={
                  zoom === null
                    ? undefined
                    : {
                        width: Math.round(deviceWidth * zoom),
                        height: Math.round(deviceHeight * zoom),
                      }
                }
                src={screen.dataUrl}
                width={screen.width}
                height={screen.height}
                alt={
                  kind === "android"
                    ? "Screenshot of the Android Emulator"
                    : "Screenshot of the iOS Simulator"
                }
                tabIndex={0}
                aria-label="Simulator touch surface. Click to focus, then type to send keystrokes"
                draggable={false}
                onPointerDown={down}
                onPointerUp={up}
                onPointerCancel={() => (press.current = undefined)}
                onKeyDown={key}
                onBlur={flush}
              />
            ) : (
              <div className="sim-screen-wait" role="status">
                {kind === "android"
                  ? "Loading the emulator…"
                  : "Loading the simulator…"}
              </div>
            )}
          </div>
          {tools &&
            captures.map((capture) => (
              <CaptureThumbnail
                key={capture.seq}
                capture={capture}
                actions={tools.captures}
                retiring={capture.retiring}
                revealLabel={tools.revealLabel}
                from={capture.from}
                onDismiss={() =>
                  setCaptures((list) =>
                    list.filter((item) => item.seq !== capture.seq),
                  )
                }
                onReturnFocus={() =>
                  surface.current?.focus({ preventScroll: true })
                }
              />
            ))}
          {inspecting && screen && tools?.addElementToChat && (
            <InspectorLayer
              elements={elements}
              surface={surface}
              frame={stageFrame}
              state={inspector}
              onAddToChat={tools.addElementToChat}
              onClose={closeInspector}
            />
          )}
        </div>
        {inspecting && (
          <InspectorPanel
            elements={elements}
            loading={reading}
            error={inspectError}
            state={inspector}
            onClose={closeInspector}
            onCopy={(text) =>
              void navigator.clipboard.writeText(text).catch(() => undefined)
            }
          />
        )}
      </div>
      {tools && logsOpen && (
        <LogsDrawer
          key={device.id}
          kind={kind}
          read={tools.readLogs}
          stop={tools.stopLogs}
          fullHeight={fullHeight}
          onToggleFullHeight={() => setFullHeight((value) => !value)}
          onClose={() => {
            setLogsOpen(false);
            setFullHeight(false);
            surface.current?.focus({ preventScroll: true });
          }}
        />
      )}
      {tools ? (
        <ControlBar
          kind={kind}
          disabled={busy}
          busy={capturing}
          recordingStartedAt={recordingSince}
          logsOpen={logsOpen}
          canRecord={canRecord(kind)}
          onButton={(name) => onInput({ type: "button", name })}
          onScreenshot={saveScreenshot}
          onToggleRecording={toggleRecording}
          onAnnotate={tools.annotate}
          onRotate={
            kind === "ios" ? () => onInput({ type: "rotate" }) : undefined
          }
          hinge={
            hinge === null
              ? undefined
              : { percent: hinge, onChange: changeHinge, onCommit: commitHinge }
          }
          inspecting={inspecting}
          onInspect={
            tools.inspect && tools.addElementToChat
              ? () => {
                  if (inspecting) return closeInspector();
                  setElements([]);
                  setInspectError(undefined);
                  inspector.setSelection({ stack: [], index: 0 });
                  setInspecting(true);
                }
              : undefined
          }
          onToggleLogs={() => {
            setLogsOpen((open) => !open);
            setFullHeight(false);
          }}
        />
      ) : (
        <ControlBar
          kind={kind}
          disabled={busy}
          busy={false}
          recordingStartedAt={null}
          logsOpen={false}
          canRecord={false}
          bare
          onRotate={
            kind === "ios" ? () => onInput({ type: "rotate" }) : undefined
          }
          onButton={(name) => onInput({ type: "button", name })}
          onScreenshot={() => undefined}
          onToggleRecording={() => undefined}
          onToggleLogs={() => undefined}
        />
      )}
      {menu && (
        <Menu
          label={`Choose ${noun}`}
          entries={[
            ...deviceEntries(
              kind,
              devices,
              device.id,
              (next) => (next.id === device.id ? undefined : onSwitch(next)),
              rowActions,
            ),
            ...deviceMenuFooter({
              kind,
              name: device.name,
              disabled: busy,
              onDetach,
              onShutdown,
            }),
          ]}
          position={menu}
          width={260}
          anchors={[picker]}
          onClose={() => setMenu(undefined)}
        />
      )}
    </div>
  );
  return deviceViewView;
}
