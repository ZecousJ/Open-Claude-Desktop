/**
 * Moving the desktop's Chat and Cowork conversations to the cloud
 * (docs/cloud-sync.md P5). The desktop sends each conversation, its project
 * and the Codex rollouts of its threads to the user's runner, which stores
 * them in the webstore and puts the rollouts in the conversation's own space,
 * so the conversation continues there with its context. Only the runner
 * implements it; the desktop calls it through its cloud client.
 */
import { bridgeMethods } from "./bridge-methods";
import type { Project } from "./types";

/** A Codex rollout file of one of the conversation's threads. */
export interface RolloutFile {
  /** `rollout-<date>T<time>-<thread id>.jsonl`. */
  name: string;
  data: Uint8Array;
}

export interface ConversationImport {
  /** The conversation as UTF-8 JSON (it may be larger than one call's body). */
  conversation: Uint8Array;
  /** The conversation's project, when it has one (without a folder). */
  project?: Pick<
    Project,
    "id" | "name" | "description" | "instructions" | "createdAt"
  >;
  rollouts: RolloutFile[];
  files?: { name: string; data: Uint8Array }[];
  blobs?: { name: string; data: Uint8Array }[];
}

export interface ConversationImported {
  id: string;
  /** "exists": the cloud already had it (a repeated move changes nothing). */
  state: "imported" | "exists";
}

export interface CloudSyncAPI {
  importConversation(input: ConversationImport): Promise<ConversationImported>;
  exportCoworkTask(
    id: string,
    device: { id: string; name: string },
  ): Promise<ConversationImport>;
  releaseCoworkTask(id: string): Promise<void>;
  linkCoworkTaskToComputer(id: string): Promise<import("./types").Conversation>;
}

export const cloudSyncMethods = bridgeMethods<CloudSyncAPI>({
  importConversation: true,
  exportCoworkTask: true,
  releaseCoworkTask: true,
  linkCoworkTaskToComputer: true,
});

/** A rollout's file name: its date folder and thread id. */
export const rolloutNamePattern =
  /^rollout-(\d{4})-(\d{2})-(\d{2})T[0-9-]+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/** Largest rollout moved (the webstore keeps uploads up to 30 MB). */
export const maxRolloutBytes = 30 * 1024 * 1024;
