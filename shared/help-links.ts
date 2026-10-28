import { defaultClaudexServiceUrl } from "./claudex-service";

export const helpSlugs = [
  "skip-approvals-safety",
  "browser-safety",
  "cowork-safety",
  "memory",
  "personalization",
  "files-and-code",
  "code-security",
  "cloud-environments",
  "connector-review",
  "directory-terms",
  "usage-policy",
  "support",
  "location-metadata",
  "developer-docs",
] as const;

export type HelpSlug = (typeof helpSlugs)[number];

let configuredOrigin: string | undefined;

export function configureHelpOrigin(origin?: string) {
  if (!origin) return;
  const url = new URL(origin);
  if (/^https?:$/.test(url.protocol)) configuredOrigin = url.origin;
}

export function helpUrl(slug?: HelpSlug, serviceOrigin?: string): string {
  const location = globalThis.location;
  const origin =
    serviceOrigin ??
    configuredOrigin ??
    (location && /^https?:$/.test(location.protocol)
      ? location.origin
      : defaultClaudexServiceUrl);
  const page = `/help${slug ? `/${slug}` : ""}`;
  // A build without a service, signed out: the path alone.
  return origin ? new URL(page, origin).href : page;
}
