import { useEffect, useRef } from "react";
import { screenRetryMs, screenIntervalMs } from "./simulator-model";
import type {
  SimulatorDevice,
  SimulatorInput,
  SimulatorAnnotateCapture,
  SimulatorKind,
  SimulatorScreen,
  IosSetupStatus,
  AndroidSetupStatus,
  SimulatorsState,
} from "../../shared/simulators";
import { attachedIds, message } from "./SimulatorPanel";
import {
  maxAttachmentsFor,
  attachmentLimitNotice,
} from "../composer/attachment-limits";
import { useSimulatorPanelActions } from "./useSimulatorPanelActions";
import type { SimulatorBridge } from "./SimulatorPanel";
import type { Conversation } from "../../shared/types";
import type { Failure } from "./simulator-model";
import type { AppController } from "../app/AppContext";

/** What useSimulatorPanelState needs from SimulatorPanel.tsx. */
export interface UseSimulatorPanelStateKit {
  access: boolean | undefined;
  alive: React.RefObject<boolean>;
  annotating: SimulatorAnnotateCapture | undefined;
  app: AppController | undefined;
  bridge: SimulatorBridge;
  busy: "shutdown" | "attach" | "boot" | "restart" | undefined;
  conversation: Conversation;
  device: SimulatorDevice | undefined;
  failure: Failure | undefined;
  kind: SimulatorKind;
  label: string;
  noun: string;
  onError: (error: unknown) => void;
  problem: string | undefined;
  refreshDevices: () => Promise<SimulatorDevice[]>;
  remembered: string;
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

export function useSimulatorPanelState(kit: UseSimulatorPanelStateKit) {
  const {
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
  } = kit;
  // The device's access for Claudex, and its screen.
  const deviceId = device?.id;
  useEffect(() => {
    setScreen(null);
    setProblem(undefined);
    if (!deviceId) return;
    if (bridge.simulatorSetSubscribed && bridge.onEvent) {
      const setSubscribed = bridge.simulatorSetSubscribed;
      const subscribe = () =>
        void setSubscribed(kind, deviceId, !document.hidden, 4).catch(
          () => undefined,
        );
      const off = bridge.onEvent((event) => {
        if (
          event.type === "simulator-frame" &&
          event.kind === kind &&
          event.id === deviceId
        )
          setScreen(event.frame);
      });
      document.addEventListener("visibilitychange", subscribe);
      subscribe();
      return () => {
        off();
        document.removeEventListener("visibilitychange", subscribe);
        void setSubscribed(kind, deviceId, false).catch(() => undefined);
      };
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let misses = 0;
    const next = async () => {
      if (stopped) return;
      if (!document.hidden) {
        try {
          const picture = await bridge.simulatorScreen(kind, deviceId);
          if (stopped) return;
          if (picture) {
            misses = 0;
            setScreen(picture);
          } else misses++;
        } catch {
          misses++;
        }
      }
      if (!stopped)
        timer = setTimeout(next, misses ? screenRetryMs : screenIntervalMs);
    };
    void next();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [bridge, kind, deviceId]);

  const attach = async (target: SimulatorDevice) => {
    setFailure(undefined);
    setWasShutDown(false);
    setBusy(target.state === "booted" ? "attach" : "boot");
    try {
      let chosen = target;
      if (target.state !== "booted") {
        await bridge.simulatorBoot(kind, target.id);
        const list = await refreshDevices();
        const booted = list.find(
          (item) =>
            item.state === "booted" &&
            (item.id === target.id ||
              (!!target.avd && item.avd === target.avd)),
        );
        if (!booted) throw new Error(`The ${noun} did not finish booting.`);
        chosen = booted;
      }
      const granted = await bridge.simulatorAccess(kind, chosen.id);
      if (!alive.current) return;
      setAccess(granted);
      setAsking(!granted);
      setAttachedId(chosen.id);
      attachedIds.set(remembered, chosen.id);
    } catch (error) {
      if (alive.current)
        setFailure({
          title: `Couldn’t start the ${noun}`,
          detail: message(error),
        });
    } finally {
      if (alive.current) setBusy(undefined);
    }
  };

  const allow = async (current: SimulatorDevice) => {
    try {
      await bridge.simulatorAllow(kind, current.id, true);
      setAccess(true);
    } catch (error) {
      onError(error);
    } finally {
      setAsking(false);
    }
  };

  // Access is read again when the pane re-mounts on a remembered device.
  useEffect(() => {
    if (!deviceId || access !== undefined) return;
    bridge
      .simulatorAccess(kind, deviceId)
      .then((granted) => alive.current && setAccess(granted))
      .catch(() => undefined);
  }, [bridge, kind, deviceId, access]);

  const send = (input: SimulatorInput) => {
    if (!deviceId) return;
    return bridge
      .simulatorInput(kind, deviceId, input)
      .then(() => {
        if (alive.current) setProblem(undefined);
      })
      .catch((error) => {
        if (alive.current) setProblem(message(error));
      });
  };

  // The control bar, the Edit and Device menus and the log drawer.
  const report = (text: string) => alive.current && setProblem(text);
  /**
   * Attach as context: the screenshot joins this conversation's draft as an
   * image, while this conversation is the one open and has room for it.
   */
  const latestApp = useRef(app);
  latestApp.current = app;
  const attachCapture = app
    ? async (path: string) => {
        if (app.activeId !== conversation.id) return false;
        const limit = maxAttachmentsFor(conversation.mode);
        if (app.attachments.length >= limit) {
          app.notify(attachmentLimitNotice(limit));
          return false;
        }
        const added = await bridge.simulatorAttachCapture(path);
        if (!alive.current || latestApp.current?.activeId !== conversation.id)
          return false;
        app.setAttachments((current) =>
          current.length >= limit ? current : [...current, added],
        );
        requestAnimationFrame(() => app.composer.current?.focus());
        return true;
      }
    : undefined;
  /**
   * Annotate: a full-size screenshot in the annotation editor; Add to chat
   * keeps the annotated picture as an attachment of this conversation's draft,
   * under the name a saved screenshot would get. Offered while a composer can
   * take it.
   */
  const capturingForAnnotate = useRef(false);
  const {
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
  } = useSimulatorPanelActions({
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
  });
  return {
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
  } as const;
}
