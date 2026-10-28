/**
 * Computer use (R10): Claudex operating apps on this computer through an
 * open-source driver, with per-app access the person grants in the
 * conversation and a Settings → System section.
 *
 * The data types live in `shared/computer-use.ts` (re-exported here); the
 * handlers are in `electron/ipc/computer-use.ts`.
 */
import { bridgeMethods } from "./bridge-methods";
import {
  defaultComputerUseSettings,
  type ComputerUseAccessRequest,
  type ComputerUseActivity,
  type ComputerUseAppRef,
  type ComputerUsePermissionKind,
  type ComputerUsePermissions,
  type ComputerUseSettings,
  type ComputerUseState,
} from "./computer-use";

export type {
  ComputerUseAccessRequest,
  ComputerUseActivity,
  ComputerUseAppRef,
  ComputerUsePermissionKind,
  ComputerUsePermissions,
  ComputerUsePermissionState,
  ComputerUseRequestedApp,
  ComputerUseSettings,
  ComputerUseState,
  ComputerUseTier,
  ComputerUseUnavailableReason,
} from "./computer-use";

export interface ComputerUseAPI {
  previewRequestFramePort(): Promise<void>;
  computerUseSetSubscribed(
    conversationId: string,
    subscribed: boolean,
    fps?: number,
  ): Promise<void>;
  computerUseState(): Promise<ComputerUseState>;
  saveComputerUseSettings(
    patch: Partial<ComputerUseSettings>,
  ): Promise<ComputerUseState>;
  /** Apps for the Add app menu, with icons as data URLs. */
  computerUseInstalledApps(): Promise<
    (ComputerUseAppRef & { icon?: string })[]
  >;
  requestComputerUsePermission(
    kind: ComputerUsePermissionKind,
  ): Promise<ComputerUsePermissions>;
  openComputerUsePermissionSettings(
    kind: ComputerUsePermissionKind,
  ): Promise<void>;
  /** Restarts the app so a newly granted permission applies. */
  relaunchForPermissions(): Promise<void>;
  answerComputerUseAccess(
    id: string,
    decision: { allow: string[]; deny: string[] } | "deny",
  ): Promise<void>;
  stopComputerUse(conversationId: string): Promise<void>;
  computerUsePreview(conversationId: string): Promise<string | null>;
  /** A screenshot the transcript refers to, as a data URL; null once removed. */
  computerUseScreenshot(
    id: string,
    size: "thumb" | "full",
  ): Promise<string | null>;
}

export const computerUseMethods = bridgeMethods<ComputerUseAPI>({
  previewRequestFramePort: true,
  computerUseSetSubscribed: true,
  computerUseState: true,
  saveComputerUseSettings: true,
  computerUseInstalledApps: true,
  requestComputerUsePermission: true,
  openComputerUsePermissionSettings: true,
  relaunchForPermissions: true,
  answerComputerUseAccess: true,
  stopComputerUse: true,
  computerUsePreview: true,
  computerUseScreenshot: true,
});

/** An access request, its answer, the indicator or the permissions changed. */
export interface ComputerUseEvent {
  type: "computer-use";
  frame?: { conversationId: string; dataUrl: string | null };
  request?: ComputerUseAccessRequest;
  /** The id of a request that was answered or withdrawn. */
  resolved?: string;
  activity?: ComputerUseActivity | null;
  permissions?: ComputerUsePermissions;
  /** Settings, policy or availability changed: read `computerUseState()` again. */
  changed?: true;
}

/** What `computerUseState()` answers when computer use can't run in this build (no driver, no account). */
export const unavailableComputerUse: ComputerUseState = {
  available: false,
  reason: "unsupported",
  settings: { ...defaultComputerUseSettings, deniedApps: [] },
  allowFullControl: false,
  activity: null,
};
