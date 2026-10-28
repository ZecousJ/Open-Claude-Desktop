import { bridgeMethods } from "./bridge-methods";

export type ExtensionValue = string | number | boolean;
export interface DesktopExtensionField {
  key: string;
  title: string;
  description?: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  sensitive: boolean;
  min?: number;
  max?: number;
}
export interface DesktopExtensionSummary {
  id: string;
  name: string;
  description?: string;
  version?: string;
  icon?: string;
  enabled: boolean;
  owned: boolean;
  blockedReason?: string;
  error?: string;
  configurable: boolean;
  uninstallable: boolean;
}
export interface DesktopExtensionDetails extends DesktopExtensionSummary {
  revision: string;
  author?: string;
  longDescription?: string;
  tools: { name: string; description?: string }[];
  prompts: { name: string; description?: string }[];
  documentation?: string;
  support?: string;
  license?: string;
  fields: DesktopExtensionField[];
  values: Record<string, ExtensionValue>;
  /** Presence only: sensitive values never leave encrypted native storage. */
  savedSecrets: string[];
  configurationUnavailable?: string;
}
export interface DesktopExtensionsAPI {
  desktopExtensions(): Promise<DesktopExtensionSummary[]>;
  desktopExtension(id: string): Promise<DesktopExtensionDetails>;
  saveDesktopExtension(input: {
    id: string;
    revision: string;
    enabled: boolean;
    values: Record<string, ExtensionValue>;
  }): Promise<DesktopExtensionDetails>;
  uninstallDesktopExtension(input: {
    id: string;
    revision: string;
  }): Promise<void>;
}
export const extensionLifecycleMethods = bridgeMethods<DesktopExtensionsAPI>({
  desktopExtensions: true,
  desktopExtension: true,
  saveDesktopExtension: true,
  uninstallDesktopExtension: true,
});
