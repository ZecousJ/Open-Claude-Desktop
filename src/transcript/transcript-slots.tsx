import { createContext, useContext, type ComponentType } from "react";
import type { Item, Turn } from "../../shared/types";
import type { Artifact } from "../ui/ArtifactTypes";

/** What Chat's steps group is given (ChatStepsGroup's own props). */
export interface StepsGroupProps {
  items: Item[];
  turn: Turn;
  active: boolean;
  awaitingApproval: boolean;
  onArtifact: (artifact: Artifact) => void;
}

/**
 * Pieces of the Chat transcript a host may draw its own way. The web and
 * desktop apps provide none, so they keep the shared rows; the phone apps'
 * renderer (src/mobile-conversation) draws the reference rows here without
 * pulling phone code into the web bundle.
 */
export interface TranscriptSlotsValue {
  /** Chat's steps group (one collapsed "N steps" row on the phones). */
  StepsGroup?: ComponentType<StepsGroupProps>;
  /** The working row before any step (the thinking verb on the phones). */
  TurnActivity?: ComponentType<{ turn: Turn; awaitingApproval: boolean }>;
  /** Drawn at the end of a finished Chat reply's action row. */
  ReplyActionsEnd?: ComponentType<{ turn: Turn }>;
  /**
   * The still mark at the end of a finished Code reply (the desktop's Code
   * star otherwise; the phones show their upright Claudex mark in every mode).
   */
  CodeEndMark?: ComponentType;
  /**
   * Code's folded tool calls (one or more consecutive calls): the phones draw
   * the official collapsed row that opens a bottom sheet, not the desktop's
   * in-place disclosure.
   */
  CodeToolGroup?: ComponentType<CodeToolGroupProps>;
  /**
   * Words the Code status line uses in place of its own (by English source
   * text): the phones keep the official app's "Working…", not Claudex's
   * "Running tools…" or "Waiting for Claudex…".
   */
  CodeStatusLabels?: Record<string, string>;
  /** A Code turn's standalone thought (the phones: the row opening "Thought process"). */
  CodeThought?: ComponentType<{ item: Item }>;
  /** The card of the files a Code turn changed (the phones' official card). */
  CodeTurnChanges?: ComponentType<{ turn: Turn; onOpen: () => void }>;
  /** The actions under an earlier Code reply (the desktop's toolbar otherwise). */
  CodeReplyActions?: ComponentType<{ turn: Turn }>;
  /** Label of the back-to-bottom button, drawn after its arrow (an icon alone otherwise). */
  ScrollToLatestLabel?: ComponentType;
}

/** What Code's folded tool-call row is given (CodeToolGroup's own props). */
export interface CodeToolGroupProps {
  items: Item[];
  turnStatus: Turn["status"];
  startedAt: number;
  /** Command item ids Codex still lists as background terminals. */
  background: Set<string>;
  onOpenBackground: () => void;
  onArtifact: (artifact: Artifact) => void;
}

export const TranscriptSlots = createContext<TranscriptSlotsValue>({});

export const useTranscriptSlots = () => useContext(TranscriptSlots);
