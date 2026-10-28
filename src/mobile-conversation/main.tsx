import React from "react";
import { currentLocale, initialLocale, setLocale } from "../i18n";
import { startDomTranslation } from "../i18n/dom";
import { createRoot } from "react-dom/client";
import type {
  ConversationActionResult,
  ConversationDocumentState,
  ConversationEvent,
  ConversationRenderState,
  ConversationUpdate,
} from "../../shared/mobile/conversation-contract";
import { ConversationBridge } from "./bridge";
import { ConversationGesture } from "./gesture";
import { applyUpdate, validateState } from "./state";
import { ConversationSurface } from "./ConversationSurface";
import { DocumentSurface } from "./DocumentSurface";
import "./styles.css";
// These same CSS-only slots are loaded by the web/desktop main entry. Keep their
// actual late cascade instead of maintaining a mobile copy of those rules.
import "../artifacts/sheet-card.slot";
import "../code-tools/browser-tools.slot";
import "../computer-use/computer-use.slot";
import "../light-main/light-main.slot";
import "../live-web/live-web.slot";
import "./layout.css";

type NativeWindow = Window & {
  webkit?: {
    messageHandlers?: {
      claudexConversation?: { postMessage(value: ConversationEvent): void };
    };
  };
  claudexConversation?: { postMessage(value: string): void };
  ClaudexConversation?: {
    render(state: ConversationRenderState): boolean;
    update(patch: ConversationUpdate): boolean;
    renderDocument(state: ConversationDocumentState): boolean;
    result(reply: ConversationActionResult): boolean;
    dispose(): void;
  };
};
const host = window as NativeWindow;
// Capture the only supported transport before rendering any model content.
const ios = host.webkit?.messageHandlers?.claudexConversation;
const android = host.claudexConversation;
const gesture = new ConversationGesture();
const bridge = new ConversationBridge(
  (event) => {
    if (ios) ios.postMessage(event);
    else if (android) android.postMessage(JSON.stringify(event));
  },
  30_000,
  () => gesture.active(),
);
const root = createRoot(document.getElementById("root")!);
let current: ConversationRenderState | undefined;
let documentState: ConversationDocumentState | undefined;
let frame: number | undefined;
let disposed = false;
let presentationEpoch = 0;
for (const name of ["pointerdown", "click", "keydown"] as const) {
  document.addEventListener(
    name,
    (event) => {
      gesture.observe(event.isTrusted);
    },
    true,
  );
}
const reject = (
  value: { sessionId?: string; revision?: number },
  error: unknown,
) => {
  bridge.event({
    version: 1,
    sessionId: value?.sessionId ?? "",
    type: "stateRejected",
    revision: value?.revision ?? -1,
    error: error instanceof Error ? error.message : String(error),
  });
  return false;
};
function schedule() {
  disposed = false;
  const epoch = ++presentationEpoch;
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = requestAnimationFrame(async () => {
    frame = undefined;
    const state = current ?? documentState;
    if (!state || disposed) return;
    await setLocale(state.locale ?? initialLocale());
    if (disposed || epoch !== presentationEpoch) return;
    document.documentElement.lang = currentLocale();
    startDomTranslation();
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.dataset.surface = "web";
    const onApplied = () =>
      bridge.event({
        version: 1,
        sessionId: state.sessionId,
        type: "stateApplied",
        revision: state.revision,
      });
    root.render(
      current ? (
        <ConversationSurface
          key={state.sessionId}
          state={current}
          bridge={bridge}
          onApplied={onApplied}
        />
      ) : (
        <DocumentSurface
          key={state.sessionId}
          state={documentState!}
          bridge={bridge}
          onApplied={onApplied}
        />
      ),
    );
  });
}
function fresh(state: { sessionId: string; revision: number }) {
  const previous = current ?? documentState;
  if (
    previous?.sessionId === state.sessionId &&
    state.revision <= previous.revision
  )
    throw Error("Stale render revision");
  if (previous?.sessionId !== state.sessionId) gesture.reset();
  bridge.setSession(state.sessionId);
}
Object.defineProperty(host, "ClaudexConversation", {
  configurable: false,
  writable: false,
  value: Object.freeze({
    render(state: ConversationRenderState) {
      try {
        validateState(state);
        fresh(state);
        current = state;
        documentState = undefined;
        schedule();
        return true;
      } catch (error) {
        return reject(state, error);
      }
    },
    update(patch: ConversationUpdate) {
      try {
        if (!current) throw Error("No conversation to update");
        current = applyUpdate(current, patch);
        schedule();
        return true;
      } catch (error) {
        return reject(patch, error);
      }
    },
    renderDocument(state: ConversationDocumentState) {
      try {
        if (
          state?.version !== 1 ||
          typeof state.sessionId !== "string" ||
          !state.sessionId ||
          !Number.isSafeInteger(state.revision) ||
          state.revision < 0 ||
          !["light", "dark"].includes(state.theme) ||
          (state.locale !== undefined &&
            (typeof state.locale !== "string" || state.locale.length > 64)) ||
          typeof state.document?.content !== "string" ||
          typeof state.document?.language !== "string"
        )
          throw Error("Invalid document state");
        fresh(state);
        current = undefined;
        documentState = state;
        schedule();
        return true;
      } catch (error) {
        return reject(state, error);
      }
    },
    result: (reply: ConversationActionResult) => bridge.result(reply),
    dispose() {
      disposed = true;
      presentationEpoch++;
      gesture.reset();
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      bridge.dispose();
      current = undefined;
      documentState = undefined;
      root.render(null);
    },
  }),
});
bridge.event({ version: 1, type: "ready" });
