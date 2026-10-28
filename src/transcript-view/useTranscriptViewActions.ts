import { useEffect, useRef } from "react";
import type { Conversation } from "../../shared/types";
import { preference } from "../../shared/settings-extras";
import {
  nextTranscriptView,
  transcriptViewLabels,
  type TranscriptView,
} from "../../shared/transcript-view";
import { showToast } from "../ui/toast-store";
import { useApp, type AppController } from "../app/AppContext";
import {
  markTranscriptViewNudged,
  noteTranscriptViewPick,
  pickedTranscriptView,
  setTranscriptView,
  transcriptViewFor,
  useTranscriptView,
} from "./transcript-view-store";

/** The Code title menu's Transcript view rows (ConversationTitle). */
export interface TranscriptViewMenu {
  view: TranscriptView;
  defaultView: TranscriptView;
  onSelect: (view: TranscriptView) => void;
  onMakeDefault: () => void;
}

/** How a view was picked; a key press waits before it nudges. */
export type TranscriptViewVia = "menu" | "keyboard";

/**
 * A key press nudges after the view stayed this long, so cycling past a
 * view with Ctrl+O does not offer it (the bundle's 1500ms).
 */
const KEYBOARD_NUDGE_MS = 1500;

/** Codex models think before they answer: Thinking is always offered. */
const thinkingShown = { thinking: true };

export const defaultTranscriptView = (app: Pick<AppController, "snapshot">) =>
  preference(app.snapshot.settings, "defaultTranscriptView");

/**
 * A notice naming a view, in English: the document's translator reads the
 * sentence and the view's name in it (src/i18n/dom.ts).
 */
function sentence(template: string, view: TranscriptView) {
  return template.replace("{mode}", transcriptViewLabels[view]);
}

/** Settings → Default transcript view, with the original's notice. */
export function makeTranscriptViewDefault(
  app: Pick<AppController, "updatePreference" | "notify">,
  view: TranscriptView,
) {
  markTranscriptViewNudged(view);
  void app
    .updatePreference({ defaultTranscriptView: view })
    .then(() => app.notify(sentence("{mode} is now the default view.", view)));
}

function offerDefault(app: AppController, view: TranscriptView) {
  markTranscriptViewNudged(view);
  showToast(sentence("Make {mode} your default view?", view), {
    action: {
      label: "Make default",
      onSelect: () => makeTranscriptViewDefault(app, view),
    },
  });
}

/**
 * The open Code session's transcript view and what changes it: the title
 * menu's rows, Make … the default, and Ctrl+O (`cycle`).
 */
export function useTranscriptViewActions(conversation: Conversation) {
  const app = useApp();
  const fallback = defaultTranscriptView(app);
  const view = useTranscriptView(conversation.id, fallback);
  const latest = useRef({ app, fallback, id: conversation.id });
  latest.current = { app, fallback, id: conversation.id };
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const select = (next: TranscriptView, via: TranscriptViewVia) => {
    const { id } = latest.current;
    setTranscriptView(id, next);
    clearTimeout(timer.current);
    const nudge = () => {
      const now = latest.current;
      if (now.id !== id || pickedTranscriptView(id) !== next) return;
      if (noteTranscriptViewPick(next, id, now.fallback))
        offerDefault(now.app, next);
    };
    if (via === "keyboard")
      timer.current = setTimeout(nudge, KEYBOARD_NUDGE_MS);
    else nudge();
  };

  const menu: TranscriptViewMenu = {
    view,
    defaultView: fallback,
    onSelect: (next) => select(next, "menu"),
    onMakeDefault: () => makeTranscriptViewDefault(app, view),
  };
  return {
    view,
    menu,
    /** Ctrl+O: the next view. */
    cycle: () => {
      const { id, fallback } = latest.current;
      select(
        nextTranscriptView(transcriptViewFor(id, fallback), thinkingShown),
        "keyboard",
      );
    },
  };
}
