/**
 * The desktop interface pack (docs/releasing.md): the window's
 * own code (`dist/`), published and signed apart from the installer, so a
 * front-end change reaches desktop users without a new installer.
 *
 * `bridgeLevel` is this build's level of `window.desktop`. It only goes up:
 * raise it by one whenever the window may call something the previous level
 * did not have (a new call or event, a new argument or result field the
 * window relies on). The main process keeps every earlier call working, so a
 * pack built at level N runs on any shell at level N or above. A pack whose
 * level is above the shell's is not used: that build first needs an
 * installer.
 */
export const bridgeLevel = 1;

/** The URL scheme and host the windows load the interface from. */
export const uiScheme = "claudex-app";
export const uiHost = "ui";
/** The path segment of the interface inside the installer. */
export const bundledUi = "bundled";

/** `manifest.json` at the root of a pack (and of the bundled `dist/`). */
export interface UiManifest {
  format: 1;
  version: string;
  bridge: number;
  /** Every file of the pack and its SHA-256 (hex), by forward-slash path. */
  files: Record<string, string>;
}

const versionPattern = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

export function validUiVersion(value: unknown): value is string {
  return typeof value === "string" && versionPattern.test(value);
}

/** Compares two pack versions (x.y.z); negative when `a` is older. */
export function compareUiVersions(a: string, b: string) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++)
    if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** A path inside a pack: relative, forward slashes, no `..`, no hidden tricks. */
export function safePackPath(value: string) {
  return (
    value.length > 0 &&
    value.length <= 300 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/** Reads a manifest; throws with a reason when it is not one. */
export function parseUiManifest(text: string): UiManifest {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("The interface pack's manifest is not JSON.");
  }
  if (!raw || raw.format !== 1)
    throw new Error("The interface pack's manifest has an unknown format.");
  if (!validUiVersion(raw.version))
    throw new Error("The interface pack has no valid version.");
  if (!Number.isInteger(raw.bridge) || raw.bridge < 1)
    throw new Error("The interface pack has no valid bridge level.");
  if (!raw.files || typeof raw.files !== "object" || Array.isArray(raw.files))
    throw new Error("The interface pack lists no files.");
  const files: Record<string, string> = {};
  for (const [name, hash] of Object.entries(raw.files)) {
    if (
      !safePackPath(name) ||
      typeof hash !== "string" ||
      !sha256Pattern.test(hash)
    )
      throw new Error(`The interface pack lists an invalid file: ${name}`);
    files[name] = hash;
  }
  if (!files["index.html"])
    throw new Error("The interface pack has no index.html.");
  return { format: 1, version: raw.version, bridge: raw.bridge, files };
}

export interface UiChoiceInput {
  /** The version the service offers now; null when it offers none; undefined when unknown (offline). */
  offered: { version: string; bridge: number } | null | undefined;
  /** The interface inside the installer. */
  bundled: { version: string };
  /** This shell's level. */
  bridge: number;
  /** Versions that failed to start too often. */
  bad: readonly string[];
}

/**
 * The interface version the windows should run: the offered pack when this
 * shell can run it, it is newer than the bundled interface and has not
 * failed; otherwise the bundled one. A service that offers nothing, or an
 * older version, takes a pack back (a withdrawal).
 */
export function chooseUi(input: UiChoiceInput): string {
  const offered = input.offered;
  if (
    !offered ||
    !validUiVersion(offered.version) ||
    offered.bridge > input.bridge ||
    input.bad.includes(offered.version) ||
    compareUiVersions(offered.version, input.bundled.version) <= 0
  )
    return bundledUi;
  return offered.version;
}

/**
 * The interface version of app `x.y.z`'s n-th pack: `(x*1000+y).z.n`. The
 * installer's own interface is n = 0, so a newer installer always outranks
 * the packs published for an older one (app 0.0.27 → 0.27.0, its packs
 * 0.27.1, 0.27.2…; app 0.0.28 → 0.28.0).
 */
export function uiVersionFor(appVersion: string, n = 0) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(appVersion);
  if (!match) return `0.0.${n}`;
  const [, major, minor, patch] = match.map(Number);
  return `${major * 1000 + minor}.${patch}.${n}`;
}
