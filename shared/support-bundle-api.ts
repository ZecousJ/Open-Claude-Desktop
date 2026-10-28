import { bridgeMethods } from "./bridge-methods";

export interface SupportSystemInfo {
  appVersion: string;
  platform: string;
  osRelease: string;
  arch: string;
}

export interface SupportBundlePreview {
  referenceId: string;
  sizeBytes: number;
  previewLines: string[];
}

export interface SupportBundleAPI {
  getSupportSystemInfo(): Promise<SupportSystemInfo>;
  captureFeedbackScreenshot(): Promise<{ token: string; sizeBytes: number }>;
  createSupportBundle(input: {
    screenshotToken?: string;
  }): Promise<SupportBundlePreview>;
  exportSupportBundle(
    referenceId: string,
  ): Promise<{ savedPath?: string; filename?: string; base64?: string }>;
  revealSupportBundle(referenceId: string): Promise<void>;
  discardSupportBundle(): Promise<void>;
}

export const supportBundleMethods = bridgeMethods<SupportBundleAPI>({
  getSupportSystemInfo: true,
  captureFeedbackScreenshot: true,
  createSupportBundle: true,
  exportSupportBundle: true,
  revealSupportBundle: true,
  discardSupportBundle: true,
});
