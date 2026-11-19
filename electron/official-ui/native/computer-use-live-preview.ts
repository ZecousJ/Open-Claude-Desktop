import type {
  BrowserWindow,
  WebContentsDidStartNavigationEventParams,
} from "electron";
import { z } from "zod";
import { PreviewStream } from "../../artifacts/preview-stream";
import type { AdapterContext } from "../api/context";
import type { NativeHost } from "./host";

const domain = "ComputerUseLivePreview";
const inactive = { active: false } as const;
const sessionPrefix = "local_";
const subscription = z.tuple([z.string(), z.boolean(), z.boolean().optional()]);

type LiveFrame = {
  active: true;
  sessionId: string;
  mode: "app";
  targetLabel: string;
  frame: string;
  capturedAt: number;
};
type Subscription = {
  sessions: Map<string, number>;
  frame?: { appId: string; value: LiveFrame };
  dispose(): void;
};

export function registerComputerUseLivePreview(
  host: NativeHost,
  ctx: AdapterContext,
) {
  const windows = new Map<BrowserWindow, Subscription>();
  let fps = 1;

  const publish = (
    window: BrowserWindow,
    entry: Subscription,
    next?: Subscription["frame"],
  ) => {
    if (entry.frame === next) return;
    entry.frame = next;
    host.emitTo(
      window,
      domain,
      "computerUsePreview_$store$_update",
      next?.value ?? inactive,
    );
  };
  const account = () => ctx.isCurrent?.() !== false && ctx.account()?.id;
  const subscribers = (sessionId: string) =>
    [...windows].filter(
      ([window, entry]) =>
        entry.sessions.has(sessionId) && host.windowForId(window.id) === window,
    );
  const target = () => {
    if (!fps || !account()) return;
    const activity = ctx.computerUseActivity?.();
    if (!activity?.app) return;
    const sessionId = sessionPrefix + activity.conversationId;
    if (subscribers(sessionId).length)
      return {
        activity,
        app: activity.app,
        sessionId,
        activation: ctx.sessionIdentity?.(),
      };
  };

  const capture = async () => {
    const source = target();
    if (!source || !ctx.localCall) return;
    const frame = await ctx
      .localCall("computerUsePreview", source.activity.conversationId)
      .catch(() => null);
    if (typeof frame === "string")
      return { ...source, frame, capturedAt: Date.now() };
  };
  const stream = new PreviewStream(capture, (image) => {
    if (!image) {
      for (const [window, entry] of windows) publish(window, entry);
      return;
    }
    const source = target();
    if (
      !source ||
      source.activity !== image.activity ||
      source.activation !== image.activation
    )
      return;
    const frame = {
      appId: image.app.id,
      value: {
        active: true,
        sessionId: image.sessionId,
        mode: "app",
        targetLabel: image.app.name,
        frame: image.frame,
        capturedAt: image.capturedAt,
      },
    } satisfies NonNullable<Subscription["frame"]>;
    for (const [window, entry] of subscribers(image.sessionId))
      publish(window, entry, frame);
  });

  const reconcile = (invalidate = false) => {
    if (invalidate) stream.setSubscribed(false);
    const source = target();
    for (const [window, entry] of windows) {
      if (
        !source ||
        invalidate ||
        entry.frame?.appId !== source.app.id ||
        entry.frame?.value.sessionId !== source.sessionId ||
        !entry.sessions.has(source.sessionId)
      )
        publish(window, entry);
    }
    stream.setSubscribed(!!source);
  };
  const observeWindow = (window: BrowserWindow): Subscription => {
    const reset = () => {
      entry.sessions.clear();
      reconcile();
    };
    const navigation = (event: WebContentsDidStartNavigationEventParams) => {
      if (event.isMainFrame && !event.isSameDocument) reset();
    };
    const contents = window.webContents;
    const entry: Subscription = {
      sessions: new Map(),
      dispose: () => {
        if (!windows.delete(window)) return;
        contents.removeListener("did-start-navigation", navigation);
        contents.removeListener("render-process-gone", reset);
        reconcile();
      },
    };
    host.onWindowDetach(window, entry.dispose);
    contents.on("did-start-navigation", navigation);
    contents.on("render-process-gone", reset);
    windows.set(window, entry);
    return entry;
  };

  const state = () => {
    const window = host.caller;
    return (
      (window && account() && windows.get(window)?.frame?.value) || inactive
    );
  };
  host.on(`${domain}.computerUsePreview_$store$_getState`, state);
  host.on(`${domain}.computerUsePreview_$store$_getStateSync`, state);
  host.answer(
    inactive,
    `${domain}.browserPreview_$store$_getState`,
    `${domain}.browserPreview_$store$_getStateSync`,
  );
  host.on(`${domain}.setFps`, (value: unknown) => {
    fps = Math.max(0, Math.min(2, z.number().parse(value)));
    if (fps) stream.setFps(fps);
    reconcile();
  });
  host.on(
    `${domain}.setSubscribed`,
    (id: unknown, on: unknown, capture: unknown) => {
      const [sessionId, subscribed, wantsCapture] = subscription.parse([
        id,
        on,
        capture,
      ]);
      const window = host.caller;
      if (
        !window ||
        !account() ||
        !wantsCapture ||
        !sessionId.startsWith(sessionPrefix) ||
        sessionId.length <= sessionPrefix.length ||
        sessionId.length > 206
      )
        return;
      const entry =
        windows.get(window) ?? (subscribed ? observeWindow(window) : undefined);
      if (!entry) return;
      const count =
        (entry.sessions.get(sessionId) ?? 0) + (subscribed ? 1 : -1);
      if (count > 0) entry.sessions.set(sessionId, count);
      else entry.sessions.delete(sessionId);
      reconcile();
    },
  );

  stream.setFps(fps);
  const offEvents = ctx.onEvent((event) => {
    if (event.type === "computer-use")
      reconcile(event.changed || !!event.permissions);
    else if (event.type === "policy") reconcile(true);
  });
  const offRetirement = ctx.onAccountDeactivating?.(() => {
    for (const entry of windows.values()) entry.sessions.clear();
    fps = 1;
    stream.setFps(fps);
    reconcile();
  });
  return () => {
    offRetirement?.();
    offEvents();
    stream.dispose();
    for (const entry of windows.values()) entry.dispose();
  };
}
