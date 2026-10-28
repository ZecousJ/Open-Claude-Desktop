/**
 * Bridge calls behind Settings → Account and Privacy; the main process
 * validates every argument. Billing is in `shared/billing-api.ts` (C5) and the
 * desktop pages in `shared/settings-desktop-api.ts`; their types are
 * re-exported here for older imports.
 */
import { bridgeMethods } from "./bridge-methods";
import type {
  HistoryAddResult,
  HistoryImportResult,
  HistoryImportRun,
  HistoryRemovePreview,
  HistoryRemoveResult,
  HistorySource,
} from "./history-import";

export type {
  BillingInfo,
  BillingSubscription,
  RedeemResult,
} from "./billing-api";
export type {
  McpServerState,
  McpServers,
  StorageCleanupPreview,
  StorageCleanupResult,
  StorageUsage,
  SystemState,
} from "./settings-desktop-api";

export interface AccountProfile {
  kind: "local" | "remote";
  /** The account's name: the local registry entry or the Sub2API username. */
  fullName: string;
  email: string;
  /** Whether the account can be deleted by its current session. */
  canDelete: boolean;
}

/**
 * One signed-in session of the account (Settings → Account → Active
 * sessions): the desktop app on a computer, or a browser on the web app.
 */
export interface ActiveSession {
  /** "device:<id>" (desktop), "web:<id>" (browser) or "app:<id>" (phone app). */
  id: string;
  kind: "desktop" | "web" | "app";
  /** The computer's name (desktop); "" for a browser or a phone app. */
  deviceName: string;
  /** darwin, win32 or linux (desktop); "" for a browser or a phone app. */
  platform: string;
  /** The browser's or the phone app's user agent; "" for the desktop app. */
  userAgent: string;
  location?: { city: string; region: string; country: string } | null;
  /** The session this window belongs to. */
  current: boolean;
  /** When this sign-in began (ms). */
  createdAt: number | null;
  /** When it was last used (ms). */
  updatedAt: number | null;
}

export interface SharedArtifact {
  /** The artifact's identity, or `hosted:<share id>` for a public link (R1). */
  identity: string;
  title: string;
  url?: string;
  /** "public": a link on the Claudex service anyone can open; missing: this computer only. */
  scope?: "local" | "public";
  /** When the public link was made (Privacy's Date published); unknown for links on this computer. */
  createdAt?: number;
}

export interface SettingsAccountAPI {
  deleteStoredCodeSessions(): Promise<void>;
  codeSharingSettings(patch?: {
    requireRepositoryAccess?: boolean;
    showName?: boolean;
  }): Promise<{ requireRepositoryAccess: boolean; showName: boolean }>;
  accountProfile(): Promise<AccountProfile>;
  setFullName(name: string): Promise<AccountProfile>;
  /** Deletes the current account and its data using its signed-in session. */
  deleteAccount(): Promise<{ hasAccounts: boolean }>;
  /** Saves a .zip of the account's conversations, projects and settings; null when cancelled. */
  exportData(): Promise<string | null>;
  /**
   * Settings → Import (desktop only): the locations added so far (a Claudex
   * export or a copied data folder), each with what it holds.
   */
  claudeAiImportSignIn: import("./claude-ai-import").ClaudeAiImportAPI["claudeAiImportSignIn"];
  claudeAiImportFetch: import("./claude-ai-import").ClaudeAiImportAPI["claudeAiImportFetch"];
  claudeAiImportCancel: import("./claude-ai-import").ClaudeAiImportAPI["claudeAiImportCancel"];
  importSources(): Promise<HistorySource[]>;
  /** Opens a picker for a location to add; null when it was cancelled. */
  importAddSource(kind: "file" | "folder"): Promise<HistoryAddResult>;
  importRemoveSource(id: string): Promise<void>;
  /** Copies what is new from the chosen locations, from `since` (ms; 0 for everything). */
  importRun(sourceIds: string[], since: number): Promise<HistoryImportResult>;
  /** The Import history, newest first. */
  importHistory(): Promise<HistoryImportRun[]>;
  /** What removing a run ("*" for all) would delete. */
  importRemovePreview(runId: string): Promise<HistoryRemovePreview>;
  importRemove(runId: string): Promise<HistoryRemoveResult>;
  /**
   * The account's signed-in sessions, most recently used first; null for an
   * account on this computer only (no Claudex service to ask).
   */
  activeSessions(): Promise<ActiveSession[] | null>;
  /**
   * Signs one session out (another device or browser; the current one signs
   * out with logoutAccount). `ended` is false when the service no longer
   * knows it (it ended or changed meanwhile).
   */
  endActiveSession(id: string): Promise<{ ended: boolean }>;
  sharedArtifacts(): Promise<SharedArtifact[]>;
  /** Stops sharing an artifact link from Privacy → Shared artifacts. */
  stopSharingArtifact(identity: string): Promise<SharedArtifact[]>;
}

/** Bridge method names for the preload script, kept beside the interface. */
export const settingsAccountMethods = bridgeMethods<SettingsAccountAPI>({
  deleteStoredCodeSessions: true,
  codeSharingSettings: true,
  accountProfile: true,
  setFullName: true,
  deleteAccount: true,
  exportData: true,
  importSources: true,
  claudeAiImportSignIn: true,
  claudeAiImportFetch: true,
  claudeAiImportCancel: true,
  importAddSource: true,
  importRemoveSource: true,
  importRun: true,
  importHistory: true,
  importRemovePreview: true,
  importRemove: true,
  activeSessions: true,
  endActiveSession: true,
  sharedArtifacts: true,
  stopSharingArtifact: true,
});
