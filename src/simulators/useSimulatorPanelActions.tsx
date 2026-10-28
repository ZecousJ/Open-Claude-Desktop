import { showToast } from "../ui/toast-store";
import {
  maxAttachmentsFor,
  attachmentLimitNotice,
} from "../composer/attachment-limits";
import type { Attachment, Conversation } from "../../shared/types";
import { message, cropElement, attachedIds, switchKey } from "./SimulatorPanel";
import type {
  SimulatorElement,
  SimulatorDevice,
  IosSetupStatus,
  SimulatorAnnotateCapture,
  SimulatorKind,
  SimulatorScreen,
  AndroidSetupStatus,
  SimulatorsState,
} from "../../shared/simulators";
import { appendToDraft } from "../browser/browser-model";
import { elementChatText } from "./SimulatorInspector";
import type { DeviceTools } from "./DeviceControls";
import { formatText, t } from "../i18n";
import { useState } from "react";
import type { DeviceAction, DeviceRowActions } from "./SimulatorScreens";
import type { SimulatorBridge } from "./SimulatorPanel";
import type { Notice } from "./SimulatorDevice";
import type { Failure } from "./simulator-model";
import type { AppController } from "../app/AppContext";

/** What useSimulatorPanelActions needs from SimulatorPanel.tsx. */
export interface UseSimulatorPanelActionsKit {
  access: boolean | undefined;
  alive: React.RefObject<boolean>;
  allow: (current: SimulatorDevice) => Promise<void>;
  annotating: SimulatorAnnotateCapture | undefined;
  app: AppController | undefined;
  attachCapture: ((path: string) => Promise<boolean>) | undefined;
  bridge: SimulatorBridge;
  busy: "shutdown" | "attach" | "boot" | "restart" | undefined;
  capturingForAnnotate: React.RefObject<boolean>;
  conversation: Conversation;
  device: SimulatorDevice | undefined;
  deviceId: string | undefined;
  failure: Failure | undefined;
  kind: SimulatorKind;
  label: string;
  latestApp: React.RefObject<AppController | undefined>;
  noun: string;
  onError: (error: unknown) => void;
  problem: string | undefined;
  refreshDevices: () => Promise<SimulatorDevice[]>;
  remembered: string;
  report: (text: string) => false | void;
  setAccess: React.Dispatch<React.SetStateAction<boolean | undefined>>;
  setAnnotating: React.Dispatch<
    React.SetStateAction<SimulatorAnnotateCapture | undefined>
  >;
  setAsking: React.Dispatch<React.SetStateAction<boolean>>;
  setAttachedId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setBusy: React.Dispatch<
    React.SetStateAction<"shutdown" | "attach" | "boot" | "restart" | undefined>
  >;
  setFailure: React.Dispatch<React.SetStateAction<Failure | undefined>>;
  setProblem: React.Dispatch<React.SetStateAction<string | undefined>>;
  setScreen: React.Dispatch<React.SetStateAction<SimulatorScreen | null>>;
  setWasShutDown: React.Dispatch<React.SetStateAction<boolean>>;
  setup: IosSetupStatus | AndroidSetupStatus | undefined;
  state: SimulatorsState | undefined;
}

export function useSimulatorPanelActions(kit: UseSimulatorPanelActionsKit) {
  const {
    access,
    alive,
    allow,
    annotating,
    app,
    attachCapture,
    bridge,
    busy,
    capturingForAnnotate,
    conversation,
    device,
    deviceId,
    failure,
    kind,
    label,
    latestApp,
    noun,
    onError,
    problem,
    refreshDevices,
    remembered,
    report,
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
  } = kit;
  const annotate =
    app &&
    deviceId &&
    bridge.simulatorCaptureScreenshot &&
    bridge.addAttachmentData
      ? () => {
          if (capturingForAnnotate.current) return;
          capturingForAnnotate.current = true;
          bridge.simulatorCaptureScreenshot!(kind, deviceId)
            .then((capture) => alive.current && setAnnotating(capture))
            .catch(() =>
              report("Couldn’t capture a screenshot to annotate. Try again."),
            )
            .finally(() => {
              capturingForAnnotate.current = false;
            });
        }
      : undefined;
  const addAnnotated = async (png: Uint8Array) => {
    const current = latestApp.current;
    if (!current || !annotating || !bridge.addAttachmentData) return;
    if (current.activeId !== conversation.id) {
      showToast("Couldn’t attach as context.");
      throw new Error("Another conversation is open.");
    }
    const limit = maxAttachmentsFor(conversation.mode);
    if (current.attachments.length >= limit) {
      current.notify(attachmentLimitNotice(limit));
      throw new Error("No room for another attachment.");
    }
    let added: Attachment;
    try {
      added = await bridge.addAttachmentData(`${annotating.name}.png`, png);
    } catch (error) {
      showToast(
        /too large|larger than|size/i.test(message(error))
          ? "The annotated screenshot is too large to add to the chat. Try a smaller display or scale."
          : "Couldn’t save your annotations. Try again.",
      );
      throw error;
    }
    const now = latestApp.current;
    if (!now || now.activeId !== conversation.id) return;
    now.setAttachments((list) =>
      list.length >= limit ? list : [...list, added],
    );
    requestAnimationFrame(() => now.composer.current?.focus());
  };
  /**
   * Inspect's Add to chat: the element cut out of a full-size screenshot as
   * an attachment, and its description with the person's note in the text.
   */
  const addElementToChat =
    app &&
    deviceId &&
    bridge.simulatorCaptureScreenshot &&
    bridge.addAttachmentData
      ? async (element: SimulatorElement, note: string) => {
          const current = latestApp.current;
          if (!current || current.activeId !== conversation.id) {
            showToast("Couldn’t attach as context.");
            throw new Error("Another conversation is open.");
          }
          const limit = maxAttachmentsFor(conversation.mode);
          if (current.attachments.length < limit) {
            const capture = await bridge.simulatorCaptureScreenshot!(
              kind,
              deviceId,
            );
            const png = await cropElement(capture.dataUrl, element.frame);
            if (png) {
              const added = await bridge.addAttachmentData!(
                `${capture.name} element.png`,
                png,
              );
              latestApp.current?.setAttachments((list) =>
                list.length >= limit ? list : [...list, added],
              );
            }
          } else current.notify(attachmentLimitNotice(limit));
          latestApp.current?.setText((text) =>
            appendToDraft(text, elementChatText(element, note)),
          );
          requestAnimationFrame(() =>
            latestApp.current?.composer.current?.focus(),
          );
        }
      : undefined;
  const tools: DeviceTools | undefined = deviceId
    ? {
        inspect: () => bridge.simulatorInspect(kind, deviceId),
        addElementToChat,
        saveScreenshot: () => bridge.simulatorSaveScreenshot(kind, deviceId),
        startRecording: () => bridge.simulatorStartRecording(kind, deviceId),
        stopRecording: () => bridge.simulatorStopRecording(kind, deviceId),
        captures: {
          attach: attachCapture,
          copyPath: async (path) => {
            if (!bridge.copyText) return false;
            await bridge.copyText(path);
            return true;
          },
          reveal: (path) =>
            void bridge.simulatorCaptureAction(path, "reveal").catch(onError),
          remove: (path) => bridge.simulatorCaptureAction(path, "delete"),
        },
        savedNotice: (capture) =>
          void showToast(
            capture.kind === "recording" && capture.kept
              ? formatText(
                  "Recording saved to {filePath} but couldn’t be moved to the Desktop",
                  { filePath: capture.path },
                )
              : formatText(
                  capture.kind === "screenshot"
                    ? "Screenshot saved to {filePath}"
                    : "Recording saved to {filePath}",
                  { filePath: capture.path },
                ),
            capture.kind === "screenshot" && attachCapture
              ? {
                  action: {
                    label: "Add to chat",
                    onSelect: () =>
                      void attachCapture(capture.path).catch(() =>
                        showToast("Couldn’t attach as context."),
                      ),
                  },
                }
              : {},
          ),
        appearance: (set) => bridge.simulatorAppearance(kind, deviceId, set),
        softwareKeyboard: (show) =>
          bridge.simulatorSoftwareKeyboard(kind, deviceId, show),
        slowAnimations: (on) =>
          bridge.simulatorSlowAnimations(kind, deviceId, on),
        hinge: (degrees) => bridge.simulatorHinge(kind, deviceId, degrees),
        clipboard: (direction) =>
          bridge.simulatorClipboard(kind, deviceId, direction),
        readLogs: (since) => bridge.simulatorLogs(kind, deviceId, since),
        stopLogs: () =>
          void bridge.simulatorLogsStop(kind, deviceId).catch(() => undefined),
        report,
        annotate,
        revealLabel:
          state?.platform === "win32" ? "Show in Explorer" : "Show in Finder",
      }
    : undefined;

  const detach = () => {
    setAttachedId(undefined);
    attachedIds.delete(remembered);
    setAccess(undefined);
  };

  const shutdown = async () => {
    if (!device) return;
    setBusy("shutdown");
    try {
      await bridge.simulatorShutdown(kind, device.id);
      detach();
      if (kind === "ios") setWasShutDown(true);
      await refreshDevices();
    } catch (error) {
      if (alive.current)
        setFailure({
          title: `Couldn’t shut down the ${noun}`,
          detail: message(error),
        });
    } finally {
      if (alive.current) setBusy(undefined);
    }
  };

  // The device rows' right-click actions (Shut down, Restart, Start, Rename…).
  const [rowBusy, setRowBusy] = useState<Record<string, DeviceAction>>({});
  const [renaming, setRenaming] = useState<SimulatorDevice>();
  const deviceAction = async (
    target: SimulatorDevice,
    action: DeviceAction,
  ) => {
    if (rowBusy[target.id] || busy) return;
    if (action === "rename") return setRenaming(target);
    if (action === "shutdown" && target.id === device?.id) return shutdown();
    const reattach = action === "restart" && target.id === device?.id;
    if (reattach) setBusy("restart");
    setFailure(undefined);
    setRowBusy((current) => ({ ...current, [target.id]: action }));
    try {
      if (action === "start") await bridge.simulatorBoot(kind, target.id);
      else if (action === "shutdown")
        await bridge.simulatorShutdown(kind, target.id);
      else {
        const next = await bridge.simulatorRestart(kind, target.id);
        if (reattach && alive.current) {
          setAttachedId(next);
          attachedIds.set(remembered, next);
          try {
            const granted = await bridge.simulatorAccess(kind, next);
            const screen = await bridge.simulatorScreen(kind, next);
            if (!screen) throw new Error();
            if (alive.current) {
              setAccess(granted);
              setAsking(!granted);
              setScreen(screen);
            }
          } catch (error) {
            if (alive.current)
              setFailure({
                title:
                  kind === "android"
                    ? "The emulator restarted but couldn’t be shown again"
                    : "The simulator restarted but couldn’t be shown again",
                detail: message(error),
              });
          }
        }
      }
      await refreshDevices();
    } catch (error) {
      if (alive.current)
        setFailure({
          title:
            action === "restart"
              ? `Couldn’t restart the ${noun}`
              : action === "start"
                ? `Couldn’t start the ${noun}`
                : `Couldn’t shut down the ${noun}`,
          detail:
            action === "restart"
              ? `${message(error)} ${t("It may now be shut down. If so, start it from the list.")}`
              : message(error),
        });
    } finally {
      if (reattach && alive.current) setBusy(undefined);
      if (alive.current)
        setRowBusy((current) => {
          const next = { ...current };
          delete next[target.id];
          return next;
        });
    }
  };
  const rename = async (target: SimulatorDevice, name: string) => {
    setRowBusy((current) => ({ ...current, [target.id]: "rename" }));
    try {
      await bridge.simulatorRename(kind, target.id, name);
      await refreshDevices();
    } catch (error) {
      if (alive.current)
        setFailure({
          title: `Couldn’t rename the ${noun}`,
          detail: message(error),
        });
    } finally {
      if (alive.current)
        setRowBusy((current) => {
          const next = { ...current };
          delete next[target.id];
          return next;
        });
    }
  };
  const rowActions: DeviceRowActions = {
    busy: rowBusy,
    onAction: (target, action) => void deviceAction(target, action),
  };

  const open = (target: Parameters<SimulatorBridge["simulatorOpen"]>[0]) => {
    bridge.simulatorOpen(target).catch(onError);
  };

  const settings = app?.snapshot.settings as unknown as
    Record<string, unknown> | undefined;
  const toolsOn = settings?.[switchKey[kind]] !== false;
  const notices: Notice[] = [];
  if (!toolsOn)
    notices.push({
      key: "off",
      text: `Claudex’s ${label} tools are turned off.`,
      action: app
        ? { label: "Open settings", run: () => app.openSettingsTab("code") }
        : undefined,
    });
  else if (access === false && device)
    notices.push({
      key: "access",
      text: `You can use this ${noun} yourself, but Claudex can’t.`,
      action: { label: "Let Claudex use it", run: () => void allow(device) },
    });
  if (kind === "ios" && setup && (setup as IosSetupStatus).input === false)
    notices.push({
      key: "idb",
      text: "Tapping, swiping and typing in the iOS Simulator need Facebook idb, which isn’t installed. Install it with:",
      code: "brew tap facebook/fb && brew install idb-companion && pip3 install fb-idb",
    });
  if (problem)
    notices.push({
      key: "problem",
      text: problem,
      action: { label: "Dismiss", run: () => setProblem(undefined) },
    });
  if (failure && device)
    notices.push({
      key: "failure",
      text: `${failure.title}. ${failure.detail}`,
      action: { label: "Dismiss", run: () => setFailure(undefined) },
    });
  return {
    open,
    notices,
    tools,
    shutdown,
    detach,
    rowActions,
    renaming,
    rename,
    setRenaming,
    addAnnotated,
  } as const;
}
