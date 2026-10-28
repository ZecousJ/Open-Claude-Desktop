export interface ChromeImportProfile {
  id: string;
  name: string;
  browser: string;
  browserName: string;
  lastUsed: boolean;
}

export interface ChromeImportSite {
  root: string;
  cookieCount: number;
  hostCount: number;
  lastAccess: number;
  /** A sign-in provider, an email service or a bank or payments site (a warning tag). */
  sensitive?: "identity" | "email" | "financial";
}

export interface ImportedChromeLogin {
  root: string;
  importedAt: number;
}

export type ChromeImportResult<T> =
  | ({ ok: true } & T)
  | {
      ok: false;
      error:
        | "no_chrome"
        | "read_failed"
        | "expired"
        | "invalid_sites"
        | "keychain_denied"
        /** Touch ID or the confirmation went unanswered for 2 minutes. */
        | "presence_timed_out";
    };

export interface ChromeImportAPI {
  getCoworkChromeImportAvailability(): Promise<{
    available: boolean;
    touchId?: boolean;
    reason?: "gate_off" | "no_chrome";
  }>;
  clearCoworkBrowserData(): Promise<boolean>;
  getChromeImportAvailability(): Promise<{
    available: boolean;
    /** The confirmation is Touch ID (macOS with a sensor). */
    touchId?: boolean;
  }>;
  getChromeImportSharedOffer(
    conversationId: string,
  ): Promise<{ offer: boolean; roots: string[] }>;
  acceptChromeImportSharedOffer(
    conversationId: string,
    keep: boolean,
  ): Promise<boolean>;
  listChromeImportProfiles(): Promise<ChromeImportProfile[]>;
  listChromeImportSites(
    conversationId: string,
    profileId: string,
  ): Promise<
    ChromeImportResult<{
      ticket: string;
      profile: ChromeImportProfile;
      sites: ChromeImportSite[];
      maxSites: number;
    }>
  >;
  importChromeLogins(
    conversationId: string,
    ticket: string,
    roots: string[],
    keep: boolean,
  ): Promise<
    ChromeImportResult<{
      results: { root: string; imported: number; failed: number }[];
      persistent: boolean;
    }>
  >;
  listImportedChromeLogins(
    conversationId: string,
  ): Promise<ImportedChromeLogin[]>;
  removeImportedChromeLogins(
    conversationId: string,
    root: string,
  ): Promise<boolean>;
}
