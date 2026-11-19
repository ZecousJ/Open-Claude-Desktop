import { randomUUID } from "node:crypto";
import {
  officialAppearanceFonts,
  officialAppearanceLocales,
  type OfficialAppearanceCapability,
} from "../../shared/official-appearance-capability";
export function createAppearanceAuthority(host: {
  accountId(): string | undefined;
  identity(): unknown;
  root(): string;
  current(): boolean;
  enabled(): boolean;
  locales?(): readonly string[];
}) {
  const owner = host.accountId(),
    identity = host.identity(),
    root = host.root(),
    enabled = host.enabled(),
    lease = randomUUID();
  const current = () => {
    try {
      return (
        !!owner &&
        identity !== undefined &&
        identity !== null &&
        identity !== "" &&
        !!root &&
        host.current() &&
        host.accountId() === owner &&
        host.identity() === identity &&
        host.root() === root &&
        host.enabled() === enabled
      );
    } catch {
      return false;
    }
  };
  const describe = (): OfficialAppearanceCapability => ({
    version: 1,
    accountId: owner ?? "",
    activationLease: lease,
    fonts: officialAppearanceFonts,
    locales: officialAppearanceLocales.filter((locale) =>
      host.locales?.().includes(locale),
    ),
    appearance: !current()
      ? { state: "unavailable", reason: "session_changed" }
      : enabled
        ? { state: "ready", reason: "ready" }
        : { state: "unavailable", reason: "disabled" },
  });
  return {
    current,
    describe,
    accepts: (value: unknown) =>
      current() && typeof value === "string" && value === lease,
    assertAppearance: () => {
      if (describe().appearance.state !== "ready")
        throw Error("Appearance settings are unavailable.");
    },
  };
}
