/**
 * Administrator policy, announcements, release notes and session states for the
 * fixture bridge. Nothing is fetched: the links point at example.com and are
 * never opened by captures.
 */
import {
  openPolicy,
  pendingPolicy,
  type Announcement,
  type ClientPolicy,
} from "../../../shared/client-policy";
import type { PolicyWithReleaseNotes } from "../../../shared/client-release";
import type { AuthStatus } from "../../../shared/types";
import type { FixtureDomain } from "./index";

export type FixturePolicy = "open" | "links" | "locked" | "pending";
/** required-soft: required, but the service does not enforce it. */
export type FixtureUpdate = "available" | "required" | "required-soft";

const origin = Date.UTC(2026, 8, 24, 9);

const serviceNotes = [
  "## Improved",
  "- Plan usage limits now show the current session and each model's weekly limit.",
  "- The account menu links to your organization's help center.",
  "",
  "## Fixed",
  "- Fixed dictation stopping after a minute on slow networks. See [the status page](https://status.example.com) or [the admin guide](https://guide.example.net/claudex).",
  "",
  '<img src="https://images.example.com/raw.png"> <b>Raw HTML is not shown.</b>',
  "",
  "![Screenshot of the Usage page](https://images.example.com/usage.png)",
].join("\n");

export function fixturePolicy(
  preset: FixturePolicy = "open",
  update?: FixtureUpdate,
  options: { releaseNotes?: boolean; imageDomains?: string[] } = {},
): ClientPolicy {
  const links: ClientPolicy["links"] = {
    help: "https://help.example.com/claudex",
    plans: "https://plans.example.com/claudex",
    apps: "https://download.example.com/claudex",
    // More rows than fit below Learn more at 1164×1049: the submenu opens upwards.
    learnMore: [
      { label: "Usage policy", url: "https://example.com/usage-policy" },
      { label: "Privacy policy", url: "https://example.com/privacy" },
      { label: "Terms of service", url: "https://example.com/terms" },
      { label: "Status", url: "https://status.example.com" },
      { label: "Release notes", url: "https://example.com/releases" },
      { label: "Security", url: "https://example.com/security" },
    ],
  };
  const policy: PolicyWithReleaseNotes =
    preset === "locked"
      ? {
          ...openPolicy,
          permissionModes: ["auto", "manual", "plan"],
          incognito: false,
          webSearch: false,
          voice: false,
          localMcpEditing: false,
          remoteImages: false,
          externalLinks: false,
          // Links to the status site still open with external links off.
          trustedLinkDomains: ["status.example.com"],
          // The fixture's "docs" server matches; "browser" is blocked.
          connectors: [{ name: "docs", command: "docs-mcp", args: [] }],
          attachments: { maxBytes: null, types: [] },
          links,
          planLabel: "Team",
        }
      : preset === "links"
        ? { ...openPolicy, links }
        : preset === "pending"
          ? { ...pendingPolicy }
          : { ...openPolicy };
  if (options.imageDomains) policy.remoteImageDomains = options.imageDomains;
  if (options.releaseNotes)
    policy.releaseNotes = {
      version: "0.2.0",
      markdown: serviceNotes,
      publishedAt: Date.UTC(2026, 8, 25, 16),
    };
  if (update)
    policy.update = {
      state: update === "available" ? "available" : "required",
      currentVersion: "0.0.1",
      latestVersion: "0.2.0",
      downloadUrl: "https://download.example.com/claudex",
      ...(update === "required-soft" ? { enforced: false } : {}),
    };
  return policy;
}

export function fixtureAnnouncements(): Announcement[] {
  return [
    {
      id: "12",
      title: "Scheduled maintenance on Saturday",
      content:
        "The model service will be unavailable on **Saturday, September 27** from 02:00 to 03:00 UTC while we upgrade the gateway.\n\nConversations on this computer are not affected.",
      popup: true,
      createdAt: origin,
      read: false,
    },
    {
      id: "9",
      title: "New models on the Pro plan",
      content:
        "Two more models are available on the Pro plan. Choose them from the model menu.",
      popup: false,
      createdAt: origin - 3 * 24 * 3_600_000,
      read: false,
    },
  ];
}

/** The service's refusal when an account already has its most devices (design 1.8). */
const deviceLimit =
  "You're signed in to Claudex on 5 devices, the most your account allows. Sign out on one of them, then sign in again.";

/** A Sub2API service's sign-in card, for the signed-out states. */
const remoteSignIn: AuthStatus["remote"] = {
  siteName: "Acme AI",
  registrationEnabled: false,
  emailVerification: false,
  invitationCode: false,
  promoCode: false,
  captchaRequired: false,
  emailDomains: [],
};

/** The administrator's policy, notices and session states. */
export const policyFixture: FixtureDomain = {
  params: {
    policy: "open|links|locked|pending",
    update: "available|required|required-soft",
    announcements: "1 adds a popup and a silent notice",
    releaseNotes: "1 adds the service's release notes for 0.2.0",
    imageDomains:
      "comma-separated hosts remote images may load from (e.g. cdn.example.net)",
    signedOut:
      "revoked|device-revoked|session-expired: the service ends the session after 600 ms",
    signIn: "device-limit: signing in fails as at the device limit",
  },
  bridge: ({ params, emit }) => {
    const preset = (params.get("policy") ?? undefined) as
      FixturePolicy | undefined;
    const update = (params.get("update") ?? undefined) as
      FixtureUpdate | undefined;
    let notices =
      params.get("announcements") === "1" ? fixtureAnnouncements() : [];
    const api: ReturnType<FixtureDomain["bridge"]> = {
      clientPolicy: async () =>
        fixturePolicy(preset, update, {
          releaseNotes: params.get("releaseNotes") === "1",
          imageDomains: params.get("imageDomains")?.split(","),
        }),
      announcements: async () => structuredClone(notices),
      markAnnouncementRead: async (id) => {
        notices = notices.map((item) =>
          item.id === id ? { ...item, read: true } : item,
        );
        return structuredClone(notices);
      },
    };
    const reason = params.get("signedOut");
    if (
      reason === "revoked" ||
      reason === "device-revoked" ||
      reason === "session-expired"
    ) {
      let signedIn = true;
      let ending: ReturnType<typeof setTimeout> | undefined;
      api.authStatus = async () => {
        // The session ends 600 ms after the window first asks, as if the
        // service revoked it while the app was open.
        ending ??= setTimeout(endSession, 600);
        return signedIn
          ? {
              hasAccounts: true,
              account: {
                id: "fixture-account",
                email: "fixture@example.invalid",
                name: "Ada",
                plan: "Max",
                remote: true,
              },
            }
          : { hasAccounts: true, remote: remoteSignIn };
      };
      const endSession = () => {
        signedIn = false;
        emit({
          type: "signed-out",
          reason,
          message:
            reason === "revoked"
              ? "Your account was signed out on all devices."
              : reason === "device-revoked"
                ? "This device was removed from your account."
                : "Your session ended. Sign in again to continue.",
        });
      };
    }
    if (params.get("signIn") === "device-limit")
      api.loginAccount = async () => {
        throw new Error(deviceLimit);
      };
    return api;
  },
};
