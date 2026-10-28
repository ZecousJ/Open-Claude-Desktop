/**
 * Research mode and web search results (R4/R5, design R45): the sources a
 * web search returned, inline citations, and a Research conversation's plan,
 * progress and report.
 *
 * The data types live in `shared/research.ts` (re-exported here); the
 * handlers are in `electron/ipc/research.ts` (R45c).
 */
import { bridgeMethods } from "./bridge-methods";
import type { ResearchState } from "./research";
import type { Conversation } from "./types";

export type {
  Citation,
  ResearchPhase,
  ResearchState,
  WebSource,
} from "./research";

export interface ResearchAPI {
  /** Turns Research on or off for a conversation (web search comes on with it). */
  setConversationResearch(
    conversationId: string,
    enabled: boolean,
  ): Promise<Conversation>;
  /** A finished Research turn's report, read from the account's folder. */
  readResearchReport(
    conversationId: string,
    turnId: string,
  ): Promise<{ title: string; markdown: string }>;
  /** Saves the report with the system save dialog; false when cancelled. */
  saveResearchReport(conversationId: string, turnId: string): Promise<boolean>;
}

export const researchMethods = bridgeMethods<ResearchAPI>({
  setConversationResearch: true,
  readResearchReport: true,
  saveResearchReport: true,
});

/** A Research turn's progress changed (between conversation updates). */
export interface ResearchEvent {
  type: "research";
  conversationId: string;
  turnId: string;
  research: ResearchState;
}
